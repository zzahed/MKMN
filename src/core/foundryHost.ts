/**
 * Foundry Local as a first-class engine of the Tauri build: version-aware discovery,
 * exact variant selection, loading (cancellable), and unloading. Driven through the
 * `foundry` CLI and the OpenAI-compatible server its daemon starts.
 *
 * Honesty boundaries:
 *  - Features are gated by the INSTALLED version, discovered at runtime ("server" vs
 *    "service" command groups, catalog shapes) — never assumed from documentation.
 *  - The device a loaded build actually runs on is taken from Foundry's own load
 *    response ("Loaded 'x' (NPU variant 'x-qnn-npu:1')") and recorded; a request for
 *    one device that got another is reported as a mismatch, never rebranded.
 *  - Simultaneous CPU+NPU+GPU execution of one model is not offered: one build is
 *    loaded at a time, on the device its variant is compiled for.
 */

import { spawn } from "child_process";
import { parseCatalogJson, parseJsonOutput, parseModelList, type FoundryVariant } from "./foundry";

export interface FoundryExe { path: string; version: string | null }

// eslint-disable-next-line no-control-regex -- strips ANSI colour codes from the console output
const ansi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const asString = (v: unknown): string | null => typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
const asNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const asBool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;
const lastWords = (out: string, count = 3): string =>
  ansi(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-count).join(" | ").slice(0, 400);

/** The settings `foundry config` understands on the installed 0.12 line. */
export const FOUNDRY_CONFIG_KEYS = ["port", "cache-directory", "idle-timeout-minutes", "log-level"] as const;
export type FoundryConfigKey = typeof FOUNDRY_CONFIG_KEYS[number];

/** The task metadata `foundry model register` accepts. */
export const FOUNDRY_REGISTER_TASKS = ["chat-completion", "vision-language-chat", "embeddings", "automatic-speech-recognition"] as const;
export type FoundryRegisterTask = typeof FOUNDRY_REGISTER_TASKS[number];

export interface FoundryConfigSetting { key: string; value: string; userSet: boolean }
export interface FoundryCacheLocation { path: string; userSet: boolean }
export interface FoundryServerStatus {
  running: boolean;
  state: string;
  pid: number | null;
  webUrls: string[];
  startedAt: string | null;
  uptime: string | null;
  logFile: string | null;
}
export interface FoundrySystemInfo {
  operatingSystem: string | null;
  architecture: string | null;
  cpu: string | null;
  logicalCores: number | null;
  physicalCores: number | null;
  totalMemoryBytes: number | null;
  availableMemoryBytes: number | null;
  diskPath: string | null;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  gpus: { name: string; vendor: string | null; videoMemoryBytes: number | null }[];
  npus: { name: string; vendor: string | null }[];
}
export interface FoundryServiceInfo {
  state: string;
  ready: boolean | null;
  webUrls: string[];
  /** Every `…Version` field Foundry reported, keyed by its own name. */
  versions: Record<string, string>;
}
export interface FoundryDiagnostics {
  system: FoundrySystemInfo | null;
  service: FoundryServiceInfo | null;
  models: { available: number | null; loaded: number | null; cached: number | null } | null;
  connectivity: { localServiceReachable: boolean | null; modelRegistryReachable: boolean | null } | null;
  warnings: string[];
}
export interface FoundryModelVariantInfo {
  id: string;
  displayName: string;
  device: string;
  executionProvider: string;
  sizeGB: number | null;
  cached: boolean | null;
}
export interface FoundryModelInfo {
  alias: string;
  id: string;
  displayName: string;
  source: string;
  task: string;
  device: string;
  publisher: string;
  license: string;
  sizeGB: number | null;
  cached: boolean | null;
  supportsToolCalling: boolean | null;
  variants: FoundryModelVariantInfo[];
}
export interface FoundryRegisterInput {
  path: string;
  modelId: string;
  task: string;
  displayName?: string;
  device?: string;
  executionProvider?: string;
  contextLength?: number;
}
export interface FoundryActionResult { ok: boolean; message: string }
export interface FoundryServerActionResult extends FoundryActionResult { server: FoundryServerStatus | null }
export interface FoundryAdminView {
  installed: boolean;
  version: string | null;
  exe: string | null;
  error?: string;
  server: FoundryServerStatus | null;
  config: FoundryConfigSetting[] | null;
  cacheLocation: FoundryCacheLocation | null;
  cache: FoundryCachedVariant[] | null;
  status: FoundryDiagnostics | null;
  statusText: string;
  recent: string[];
}

/** The first local URL in a command's output. */
function localUrl(out: string): string | null {
  const m = ansi(out).match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i);
  return m ? `http://127.0.0.1:${m[1]}` : null;
}

/** The known install locations, in order; %LOCALAPPDATA%\Microsoft\WindowsApps is the documented one. */
export function findFoundry(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = () => false): string | null {
  const candidates: string[] = [];
  if (env.FOUNDRY_PATH) candidates.push(env.FOUNDRY_PATH);
  if (env.LOCALAPPDATA) candidates.push(`${env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\foundry.exe`);
  candidates.push("foundry.exe"); // PATH
  return candidates.find((c) => (c === "foundry.exe" ? true : exists(c))) ?? (exists("foundry.exe") ? "foundry.exe" : null);
}

/** "0.12.1" → [0, 12, 1]; null when unparsable (feature gates then answer false). */
export function parseVersion(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** The device of the build Foundry said it loaded: "Loaded 'x' (NPU variant 'x-qnn-npu:1') into memory". */
export function loadedVariant(out: string): { device: string; variant: string } | null {
  const m = out.replace(/\s+/g, " ").match(/\(?(NPU|GPU|CPU)\s+variant\s+'([^']+)'/i);
  return m ? { device: m[1].toUpperCase(), variant: m[2] } : null;
}

export interface FoundryCachedVariant { alias: string; device: string; sizeGB: number | null; loaded: boolean }
const cacheColumns = (line: string) => ansi(line).replace(/[│┃║|]/g, "  ").trim().split(/\s{2,}/).map((column) => column.trim());

/**
 * `foundry cache list` (0.12): `Alias | Size | Device | Loaded` rows with box drawing
 * and ANSI colours. Older versions print other shapes; rows without a device column
 * yield device "" (unknown — never guessed).
 */
export function parseCacheList(out: string): FoundryCachedVariant[] {
  const rows: FoundryCachedVariant[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const cols = cacheColumns(raw);
    const line = cols.join(" ");
    if (!line || /^[-+=\s]+$/.test(line) || /\bAlias\b.*\bDevice\b/i.test(line)) continue;
    if (cols.length < 3) continue;
    const alias = cols[0];
    if (!alias || /^(alias|name)$/i.test(alias)) continue;
    const size = cols.find((c) => /^[\d.]+\s*(GB|MB|GiB|MiB)$/i.test(c));
    const device = cols.find((c) => /^(NPU|GPU|CPU)$/i.test(c))?.toUpperCase() ?? "";
    const loaded = /●|\bloaded\b|\byes\b/i.test(line) && !/○/.test(raw);
    const gb = size ? (parseFloat(size) * (/G/i.test(size) ? (/GiB$/i.test(size) ? 1.073741824 : 1) : /MiB$/i.test(size) ? 1.073741824 / 1024 : 1 / 1024)) : null;
    rows.push({ alias, device, sizeGB: gb === null ? null : Math.round(gb * 100) / 100, loaded });
  }
  return rows;
}

/**
 * `foundry cache list -o json` (0.12): `{models:[{alias,device,fileSizeMb,loaded,…}]}`. Null when the
 * shape is not that JSON, so the text table is used instead on older versions.
 */
export function parseCacheJson(json: unknown, requireLoaded = false): FoundryCachedVariant[] | null {
  const root = json as { models?: unknown[]; variants?: unknown[] } | null;
  const list = Array.isArray(json) ? json : root?.models ?? root?.variants;
  if (!Array.isArray(list)) return null;
  if (requireLoaded && !list.every((row) => {
    if (!row || typeof row !== "object") return false;
    const m = row as Record<string, unknown>;
    const alias = m.alias ?? m.name;
    return typeof alias === "string" && !!alias.trim() && typeof m.loaded === "boolean";
  })) return null;
  return list.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const m = x as Record<string, unknown>;
    const alias = String(m.alias ?? m.name ?? "");
    if (!alias) return [];
    const device = String(m.device ?? "").toUpperCase();
    const mb = Number(m.fileSizeMb ?? m.fileSizeMB ?? NaN);
    const gb = Number.isFinite(mb) ? mb / 1024 : typeof m.sizeGB === "number" ? m.sizeGB : null;
    return [{
      alias,
      device: /^(CPU|GPU|NPU)$/.test(device) ? device : "",
      sizeGB: gb === null ? null : Math.round(gb * 100) / 100,
      loaded: m.loaded === true
    }];
  });
}

/** `foundry server status -o json` (0.12) names its bindings in `webUrls`. */
export function parseStatusJson(json: unknown): string | null {
  const j = json as { webUrls?: unknown; WebUrls?: unknown; endpoints?: unknown; Endpoints?: unknown } | null;
  const urls = j?.webUrls ?? j?.WebUrls ?? j?.endpoints ?? j?.Endpoints;
  if (!Array.isArray(urls)) return null;
  const u = urls.find((x) => typeof x === "string" && /^https?:\/\//i.test(x));
  return typeof u === "string" ? localUrl(u) : null;
}

/** `foundry config show -o json`: the four persistent settings and whether the person set each one. */
export function parseConfigJson(json: unknown): FoundryConfigSetting[] | null {
  const j = asRecord(json);
  const list = Array.isArray(j?.settings) ? j.settings : null;
  if (!list) return null;
  return list.flatMap((x) => {
    const m = asRecord(x);
    if (!m || typeof m.key !== "string" || !m.key) return [];
    return [{ key: m.key, value: String(m.value ?? ""), userSet: m.userSet === true }];
  });
}

/** The text table `foundry config show` prints when `-o json` is not available. */
export function parseConfigText(out: string): FoundryConfigSetting[] | null {
  const rows: FoundryConfigSetting[] = [];
  for (const raw of ansi(out).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cols.length < 3 || /^[-+=]+$/.test(cols[0]) || /^key$/i.test(cols[0])) continue;
    if (!cols[0]) continue;
    rows.push({ key: cols[0], value: cols[1], userSet: !/^(default|defaults|environment|env)$/i.test(cols[2]) });
  }
  return rows.length ? rows : null;
}

/** `foundry cache location -o json`. */
export function parseCacheLocationJson(json: unknown): FoundryCacheLocation | null {
  const j = asRecord(json);
  if (!j || typeof j.path !== "string" || !j.path.trim()) return null;
  return { path: j.path, userSet: j.userSet === true };
}

/** `foundry cache location` prints `■ note: <path>` (or just the path). */
export function parseCacheLocationText(out: string): FoundryCacheLocation | null {
  const clean = ansi(out);
  const line = clean.split(/\r?\n/).map((l) => l.trim()).find((l) => /note:\s*[A-Za-z]:\\|^[A-Za-z]:\\|note:\s*\//i.test(l)) ?? "";
  const m = /(?:note:\s*)?([A-Za-z]:\\[^\r\n]+|\/[^\r\n]+)/i.exec(line);
  return m ? { path: m[1].trim(), userSet: false } : null;
}

/** `foundry server status -o json` (0.12): running, state, pid, webUrls, startedAt, uptime, logFile. */
export function parseServerStatusJson(json: unknown): FoundryServerStatus | null {
  const j = asRecord(json);
  if (!j) return null;
  const running = asBool(j.running);
  const state = asString(j.state) ?? "";
  if (running === null && !state && !Array.isArray(j.webUrls) && j.pid === undefined) return null;
  const urls = Array.isArray(j.webUrls) ? j.webUrls.filter((u): u is string => typeof u === "string") : [];
  return {
    running: running ?? (!!state && !/stopped|not running|idle/i.test(state)),
    state,
    pid: asNumber(j.pid),
    webUrls: urls,
    startedAt: asString(j.startedAt),
    uptime: asString(j.uptime),
    logFile: asString(j.logFile)
  };
}

/** The text `foundry server status` table: State / PID / Started / Uptime / Web URLs / Log file. */
export function parseServerStatusText(out: string): FoundryServerStatus | null {
  const clean = ansi(out);
  const values = new Map<string, string>();
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    // The CLI pads its table columns, but a short terminal can leave one space;
    // the known labels are matched first so "Web URLs" is not split into "Web".
    const m = /^(State|PID|Started(?: at)?|Uptime|Web URLs?|Log(?: file)?|Running)\s*:?\s+(.+)$/i.exec(line)
      ?? /^([A-Za-z][A-Za-z ]{1,24}?)\s{2,}(.+)$/.exec(line)
      ?? /^([A-Za-z][A-Za-z ]{1,24}?):\s*(.+)$/.exec(line);
    if (!m) continue;
    values.set(m[1].trim().toLowerCase(), m[2].trim());
  }
  if (!values.size && !/not running|stopped/i.test(clean)) return null;
  const state = values.get("state") ?? (/not running|stopped/i.test(clean) ? "stopped" : "");
  const runningText = values.get("running");
  const running = runningText ? /^(true|yes|running|ready)$/i.test(runningText) : !!state && !/stopped|not running/i.test(state);
  const urls = (values.get("web urls") ?? values.get("web url") ?? values.get("endpoint") ?? "")
    .split(/\s+/).filter((u) => /^https?:\/\//i.test(u));
  return {
    running,
    state,
    pid: asNumber(values.get("pid")),
    webUrls: urls,
    startedAt: values.get("started") ?? values.get("started at") ?? null,
    uptime: values.get("uptime") ?? null,
    logFile: values.get("log file") ?? values.get("log") ?? null
  };
}

/** `foundry status -o json` (0.12): system, service, models, connectivity, warnings. */
export function parseDiagnosticsJson(json: unknown): FoundryDiagnostics | null {
  const j = asRecord(json);
  if (!j) return null;
  const system = asRecord(j.system);
  const service = asRecord(j.service);
  const models = asRecord(j.models);
  const connectivity = asRecord(j.connectivity);
  if (!system && !service && !models && !connectivity) return null;

  const versions: Record<string, string> = {};
  for (const [key, value] of Object.entries(service ?? {})) {
    if (/Version$/i.test(key) && (typeof value === "string" || typeof value === "number")) versions[key] = String(value);
  }
  const serviceUrls = Array.isArray(service?.webUrls) ? service.webUrls.filter((u): u is string => typeof u === "string") : [];
  const gpus = Array.isArray(system?.gpus) ? system.gpus.flatMap((x) => {
    const m = asRecord(x);
    const name = asString(m?.name);
    return name ? [{ name, vendor: asString(m?.vendor), videoMemoryBytes: asNumber(m?.videoMemoryBytes) }] : [];
  }) : [];
  const npus = Array.isArray(system?.npus) ? system.npus.flatMap((x) => {
    const m = asRecord(x);
    const name = asString(m?.name);
    return name ? [{ name, vendor: asString(m?.vendor) }] : [];
  }) : [];

  return {
    system: system ? {
      operatingSystem: asString(system.operatingSystem),
      architecture: asString(system.architecture),
      cpu: asString(system.cpu),
      logicalCores: asNumber(system.logicalCores),
      physicalCores: asNumber(system.physicalCores),
      totalMemoryBytes: asNumber(system.totalMemoryBytes),
      availableMemoryBytes: asNumber(system.availableMemoryBytes),
      diskPath: asString(system.diskPath),
      diskTotalBytes: asNumber(system.diskTotalBytes),
      diskFreeBytes: asNumber(system.diskFreeBytes),
      gpus,
      npus
    } : null,
    service: service ? {
      state: asString(service.state) ?? "",
      ready: asBool(service.ready),
      webUrls: serviceUrls,
      versions
    } : null,
    models: models ? {
      available: asNumber(models.available),
      loaded: asNumber(models.loaded),
      cached: asNumber(models.cached)
    } : null,
    connectivity: connectivity ? {
      localServiceReachable: asBool(connectivity.localServiceReachable),
      modelRegistryReachable: asBool(connectivity.modelRegistryReachable)
    } : null,
    warnings: Array.isArray(j.warnings) ? j.warnings.filter((w): w is string => typeof w === "string") : []
  };
}

/** `foundry model info <alias> -o json`, including the execution provider of each variant. */
export function parseModelInfoJson(json: unknown): FoundryModelInfo | null {
  const root = asRecord(json);
  const m = asRecord(root?.model) ?? root;
  if (!m || typeof m.alias !== "string" || !m.alias) return null;
  const variants = Array.isArray(m.variants) ? m.variants.flatMap((x) => {
    const v = asRecord(x);
    if (!v || typeof v.id !== "string" || !v.id) return [];
    const mb = asNumber(v.fileSizeMb);
    return [{
      id: v.id,
      displayName: asString(v.displayName) ?? v.id,
      device: (asString(v.device) ?? "").toUpperCase(),
      executionProvider: asString(v.executionProvider) ?? "",
      sizeGB: mb === null ? null : Math.round((mb / 1024) * 100) / 100,
      cached: asBool(v.cached)
    }];
  }) : [];
  const mb = asNumber(m.fileSizeMb);
  return {
    alias: m.alias,
    id: asString(m.id) ?? "",
    displayName: asString(m.displayName) ?? m.alias,
    source: asString(m.source) ?? "",
    task: asString(m.type) ?? "",
    device: (asString(m.device) ?? "").toUpperCase(),
    publisher: asString(m.publisher) ?? "",
    license: asString(m.license) ?? "",
    sizeGB: mb === null ? null : Math.round((mb / 1024) * 100) / 100,
    cached: asBool(m.cached),
    supportsToolCalling: asBool(m.supportsToolCalling),
    variants
  };
}

/** The Field/Value table older `foundry model info` versions print before their variant table. */
export function parseModelInfoText(out: string): FoundryModelInfo | null {
  const fields = new Map<string, string>();
  for (const raw of ansi(out).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cols = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cols.length < 2 || !cols[1] || /^[-+=]+$/.test(cols[0]) || /^field$/i.test(cols[0])) continue;
    if (cols[0]) fields.set(cols[0].toLowerCase(), cols[1]);
  }
  const alias = fields.get("alias");
  if (!alias) return null;
  const tools = fields.get("tools");
  return {
    alias,
    id: fields.get("model id") ?? "",
    displayName: fields.get("display name") ?? alias,
    source: fields.get("source") ?? "",
    task: fields.get("type") ?? "",
    device: "",
    publisher: fields.get("publisher") ?? "",
    license: fields.get("license") ?? "",
    sizeGB: null,
    cached: null,
    supportsToolCalling: tools ? /^(yes|true)$/i.test(tools) : null,
    variants: []
  };
}

export interface FoundryRunOpts { timeoutMs?: number; signal?: AbortSignal; onLine?: (line: string) => void }

/** The primitive this module drives the CLI with (replaced in tests). */
export type FoundryRunner = (args: string[], opts?: FoundryRunOpts) => Promise<{ code: number; out: string; notFound?: boolean }>;

/** A real runner: one `foundry …` child, killed when `signal` aborts; complete lines reach `onLine` as they arrive. */
export function cliRunner(exe: string): FoundryRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      if (opts?.signal?.aborted) return resolve({ code: 130, out: "aborted before start" });
      const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let pending = "";
      const onChunk = (d: Buffer) => {
        const s = String(d);
        out += s;
        if (!opts?.onLine) return;
        pending += s;
        const parts = pending.split(/\r\n|\n|\r/);
        pending = parts.pop() ?? "";
        for (const line of parts) opts.onLine(ansi(line));
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, opts?.timeoutMs ?? 60_000);
      const onAbort = () => { try { child.kill(); } catch { /* gone */ } };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      const done = (code: number, notFound = false) => {
        clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve({ code, out, notFound });
      };
      child.on("error", (e: NodeJS.ErrnoException) => { out += e.message; done(1, e.code === "ENOENT"); });
      child.on("close", (code) => done(code ?? 1));
    });
}

export interface LoadedFoundry {
  endpoint: string;
  /** The exact build id to ask completions for — from Foundry's own response, never guessed. */
  modelId: string;
  /** The device of the build Foundry reported loading. */
  device: string;
  /** The variant string Foundry reported ("" when it said none). */
  variant: string;
  alias: string;
}

/** Version-aware feature gates, derived from the discovered version. */
export class FoundryFeatures {
  constructor(public version: string | null) {}
  private get v() { return parseVersion(this.version) ?? [0, 0, 0]; }
  /** 0.12 renamed `service` → `server`; both are tried by the loader, but diagnostics name what exists. */
  get serverGroupKnown(): boolean { return this.v[0] > 0 || this.v[1] >= 12; }
  /** A version was read at all: every Foundry Local release so far is 0.x (0.12.1 was named "not installed"). */
  get anyFeatureKnown(): boolean { return parseVersion(this.version) !== null; }
  get label(): string { return this.version ?? "unknown version"; }
}

export class FoundryHost {
  private executableMissing = false;
  get missing(): boolean { return this.executableMissing; }
  features = new FoundryFeatures(null);
  recent: string[] = [];
  /** The alias this host has loaded right now (null = none). */
  loaded: LoadedFoundry | null = null;
  private base: string | null = null;
  private catalogCache: { at: number; models: FoundryVariant[] } | null = null;

  constructor(private run: FoundryRunner, private log: (line: string) => void = () => undefined, private fetchFn: typeof fetch = fetch) {}

  /** Version-aware discovery: what the installed CLI says it is. False when absent. */
  async discover(): Promise<boolean> {
    const r = await this.run(["--version"], { timeoutMs: 15_000 }).catch(() => ({ code: 1, out: "", notFound: false }));
    this.executableMissing = r.notFound === true;
    const version = r.code === 0 ? r.out.trim().split(/\r?\n/)[0] || null : null;
    this.features = new FoundryFeatures(version);
    this.recent.push(`$ foundry --version → ${version ?? `no answer (exit ${r.code})`}`);
    return version !== null;
  }

  private async alive(base: string): Promise<boolean> {
    return (await this.answer(base)) === "ok";
  }

  /** "ok": the health check passed; "error": the daemon answered, wrongly; "down": nothing answered (yet). */
  private async answer(base: string): Promise<"ok" | "error" | "down"> {
    return this.fetchFn(`${base}/v1/models`, { signal: AbortSignal.timeout(3_000) }).then((r) => (r.ok ? "ok" as const : "error" as const)).catch(() => "down" as const);
  }

  /** How long a daemon that has just said it is ready may take to open its port, and how often it is asked. */
  readyWaitMs = 30_000;
  readyPollMs = 500;

  /**
   * Foundry Local 0.12.1 prints "Server ready (<url>)" before that port accepts a connection (measured:
   * refused once, answering 2 s later). A port that is not open yet is asked again until `readyWaitMs`; a daemon
   * that ANSWERS with an error is not waited for (it is restarted, as before).
   */
  private async aliveSoon(base: string): Promise<boolean> {
    const until = Date.now() + this.readyWaitMs;
    for (;;) {
      const a = await this.answer(base);
      if (a !== "down") return a === "ok";
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, this.readyPollMs));
    }
  }

  /** Ask the daemon where it serves: its text status first, its JSON status when the text cannot be read. */
  private async readStatusUrl(group: string, seed: string): Promise<string> {
    const status = await this.run([group, "status"], { timeoutMs: 20_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    const fromText = localUrl(`${seed}\n${status.out}`);
    if (fromText) return fromText;
    const json = await this.run([group, "status", "-o", "json"], { timeoutMs: 20_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    return parseStatusJson(parseJsonOutput(json.out)) ?? localUrl(json.out) ?? "";
  }

  /**
   * Where the OpenAI-compatible server listens, starting it when needed. The port is chosen by
   * Foundry at every start, so it is read from the daemon and health-checked — never hardcoded.
   * A daemon that says it runs but does not answer is restarted once, as the troubleshooting
   * guide recommends for a port-binding failure.
   */
  async serviceUrl(): Promise<string> {
    if (this.base && await this.alive(this.base)) return this.base;
    this.base = null;
    let last = "";
    for (const group of ["server", "service"]) {
      const started = await this.run([group, "start"], { timeoutMs: 60_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
      if (/unknown command|unrecognized/i.test(started.out)) { last = started.out; continue; }
      const url = await this.readStatusUrl(group, started.out);
      if (url && await this.aliveSoon(url)) {
        this.base = url;
        this.recent.push(`$ foundry ${group} start → ${url}`);
        return url;
      }
      last = url ? `${url} did not answer` : started.out || "no answer";
      const restarted = await this.run([group, "restart"], { timeoutMs: 90_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
      if (!/unknown command|unrecognized/i.test(restarted.out)) {
        const again = await this.readStatusUrl(group, restarted.out);
        if (again && await this.aliveSoon(again)) {
          this.base = again;
          this.recent.push(`$ foundry ${group} restart → ${again}`);
          this.log("the Foundry Local server did not answer at first; a restart brought it back.");
          return again;
        }
        last = again ? `${again} did not answer after a restart` : restarted.out || last;
      }
    }
    const logs = await this.logs(20).catch(() => "");
    const tail = logs.split(/\r?\n/).filter((l) => l.trim()).slice(-6).join(" | ");
    throw new Error(`the Foundry Local server did not answer${last ? ` (${last.replace(/\s+/g, " ").slice(0, 200)})` : ""}${tail ? `; its last log lines: ${tail.slice(0, 400)}` : ""}`);
  }

  /** Restart the daemon (the documented fix for a service that cannot bind its port). */
  async restart(): Promise<void> {
    for (const group of ["server", "service"]) {
      const r = await this.run([group, "restart"], { timeoutMs: 90_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
      if (/unknown command|unrecognized/i.test(r.out)) continue;
      this.base = null;
      this.recent.push(`$ foundry ${group} restart  (exit ${r.code})`, ...ansi(r.out).trim().split(/\r?\n/).slice(-6).map((l) => `  ${l.slice(0, 200)}`));
      if (r.code !== 0) throw new Error(r.out.replace(/\s+/g, " ").slice(0, 300) || `restart failed (exit ${r.code})`);
      return;
    }
    throw new Error("this version of Foundry Local does not know a server restart command");
  }

  /** The daemon and SDK log lines the CLI can read, newest last. */
  async logs(lines = 20): Promise<string> {
    for (const group of ["server", "service"]) {
      const r = await this.run([group, "logs", "-n", String(lines)], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
      if (/unknown command|unrecognized/i.test(r.out)) continue;
      if (r.code === 0) return ansi(r.out).trim();
    }
    return "";
  }

  /**
   * The catalog this version offers (`foundry model list -o json` first, its text table otherwise).
   * Null when it cannot be read; an empty list is not invented. Cached for five minutes.
   */
  async catalog(force = false): Promise<FoundryVariant[] | null> {
    if (!force && this.catalogCache && Date.now() - this.catalogCache.at < 5 * 60_000) return this.catalogCache.models;
    const json = await this.run(["model", "list", "-o", "json"], { timeoutMs: 120_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    let models = json.code === 0 ? parseCatalogJson(parseJsonOutput(json.out)) : [];
    this.recent.push(`$ foundry model list -o json → ${models.length} models (exit ${json.code})`);
    if (!models.length) {
      const table = await this.run(["model", "list"], { timeoutMs: 120_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
      models = table.code === 0 ? parseModelList(table.out) : [];
      this.recent.push(`$ foundry model list → ${models.length} models (exit ${table.code})`);
    }
    if (!models.length) return null;
    this.catalogCache = { at: Date.now(), models };
    return models;
  }

  /** The catalog is stale after a download or a removal. */
  invalidateCatalog(): void { this.catalogCache = null; }

  /** What is cached right now, or null when the cache could not be read. */
  async cached(requireLoaded = false): Promise<FoundryCachedVariant[] | null> {
    const json = await this.run(["cache", "list", "-o", "json"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    if (json.code === 0) {
      const rows = parseCacheJson(parseJsonOutput(json.out), requireLoaded);
      if (rows !== null) return rows;
    }
    let r = await this.run(["cache", "list"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    if (r.code !== 0) r = await this.run(["cache", "ls"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    if (r.code !== 0 || !r.out.trim()) return null;
    const rows = parseCacheList(r.out);
    if (requireLoaded) {
      const table = r.out.split(/\r?\n/).map(cacheColumns);
      const header = table.findIndex((columns) => columns.includes("Alias") && columns.includes("Loaded"));
      if (header < 0) return null;
      const loaded = table[header].indexOf("Loaded");
      const records = table.slice(header + 1).filter((columns) => columns.some((column) => /[\p{L}\p{N}]/u.test(column)));
      if (records.length !== rows.length || records.some((columns) =>
        !/^(?:loaded|unloaded|yes|no|●|○)$/i.test(columns[loaded] ?? ""))) return null;
    }
    return rows;
  }

  /**
   * Exact variant selection: the CACHED build of `alias` for `wantedDevice`
   * ("NPU"|"GPU"|"CPU"|null for the only/best one). Refuses with a reason when the
   * device build is not cached — availability is from the cache, never from a
   * platform name.
   */
  async selectVariant(alias: string, wantedDevice: string | null): Promise<{ alias: string; device: string } | { error: string }> {
    const list = await this.cached();
    if (list === null) return { error: "the Foundry Local cache could not be read (is it installed?)" };
    const forAlias = list.filter((v) => v.alias.toLowerCase() === alias.toLowerCase());
    if (!forAlias.length) return { error: `${alias} is not in the Foundry Local cache (install it first)` };
    if (wantedDevice) {
      const exact = forAlias.find((v) => v.device === wantedDevice.toUpperCase());
      if (!exact) {
        const have = forAlias.map((v) => v.device || "unknown device").join(", ");
        return { error: `no cached ${wantedDevice.toUpperCase()} build of ${alias} (cached: ${have})` };
      }
      return { alias: exact.alias, device: exact.device };
    }
    const best = forAlias.find((v) => v.device === "NPU") ?? forAlias.find((v) => v.device === "GPU") ?? forAlias[0];
    return { alias: best.alias, device: best.device };
  }

  /**
   * The persistent settings `foundry config show` reports, with their sources.
   * JSON first; the text table when this version has no `-o json`.
   */
  async config(): Promise<FoundryConfigSetting[] | null> {
    const json = await this.run(["config", "show", "-o", "json"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    if (json.code === 0) {
      const rows = parseConfigJson(parseJsonOutput(json.out));
      if (rows !== null) return rows;
    }
    const table = await this.run(["config", "show"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.recent.push(`$ foundry config show → ${table.code === 0 ? "read" : `exit ${table.code}`}`);
    return table.code === 0 ? parseConfigText(table.out) : null;
  }

  /** Persist one setting. `--force` applies daemon-affecting changes without an interactive prompt. */
  async configSet(key: string, value: string): Promise<FoundryActionResult> {
    if (!FOUNDRY_CONFIG_KEYS.includes(key as FoundryConfigKey)) {
      return { ok: false, message: `Foundry Local has no setting named "${key}".` };
    }
    const v = String(value ?? "").trim();
    if (!v) return { ok: false, message: `A value is needed for ${key}.` };
    if (v.length > 1_000) return { ok: false, message: `The value for ${key} is too long.` };
    const r = await this.run(["config", "set", key, v, "--force"], { timeoutMs: 90_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.recent.push(`$ foundry config set ${key} ${v} --force (exit ${r.code})`, ...ansi(r.out).trim().split(/\r?\n/).slice(-4).map((l) => `  ${l.slice(0, 200)}`));
    if (key === "port" || key === "cache-directory") this.base = null;
    if (key === "cache-directory") this.invalidateCatalog();
    return { ok: r.code === 0, message: lastWords(r.out) || (r.code === 0 ? `${key} set to ${v}.` : `exit ${r.code}`) };
  }

  /** Reset one setting, or every setting when `key` is omitted. */
  async configReset(key?: string): Promise<FoundryActionResult> {
    if (key && !FOUNDRY_CONFIG_KEYS.includes(key as FoundryConfigKey)) {
      return { ok: false, message: `Foundry Local has no setting named "${key}".` };
    }
    const args = ["config", "reset", ...(key ? [key] : []), "--force"];
    const r = await this.run(args, { timeoutMs: 90_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.recent.push(`$ foundry ${args.join(" ")} (exit ${r.code})`, ...ansi(r.out).trim().split(/\r?\n/).slice(-4).map((l) => `  ${l.slice(0, 200)}`));
    this.base = null;
    this.invalidateCatalog();
    return { ok: r.code === 0, message: lastWords(r.out) || (r.code === 0 ? (key ? `${key} reset.` : "All settings reset.") : `exit ${r.code}`) };
  }

  /** Where Foundry keeps its model cache. JSON first; its `note:` line otherwise. */
  async cacheLocation(): Promise<FoundryCacheLocation | null> {
    const json = await this.run(["cache", "location", "-o", "json"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    if (json.code === 0) {
      const parsed = parseCacheLocationJson(parseJsonOutput(json.out));
      if (parsed) return parsed;
    }
    const text = await this.run(["cache", "location"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    return text.code === 0 ? parseCacheLocationText(text.out) : null;
  }

  /** Point Foundry's cache at an existing folder; `--force` accepts the daemon restart. */
  async cacheSet(path: string): Promise<FoundryActionResult> {
    const p = String(path ?? "").trim();
    if (!p) return { ok: false, message: "Choose a cache folder first." };
    if (p.length > 2_000) return { ok: false, message: "The cache folder path is too long." };
    const r = await this.run(["cache", "cd", p, "--force"], { timeoutMs: 90_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.recent.push(`$ foundry cache cd "${p}" --force (exit ${r.code})`, ...ansi(r.out).trim().split(/\r?\n/).slice(-4).map((l) => `  ${l.slice(0, 200)}`));
    this.base = null;
    this.invalidateCatalog();
    return { ok: r.code === 0, message: lastWords(r.out) || (r.code === 0 ? `The cache now uses ${p}.` : `exit ${r.code}`) };
  }

  /** Remove one cached model, or every cached model when no alias is given. */
  async cacheRemove(alias?: string): Promise<FoundryActionResult> {
    if (alias) {
      const removed = await this.remove(alias);
      return { ok: removed.ok, message: removed.message };
    }
    const loaded = await this.loadedModels().catch(() => [] as string[]);
    for (const name of loaded) await this.run(["model", "unload", name], { timeoutMs: 60_000 }).catch(() => undefined);
    this.loaded = null;
    const r = await this.run(["cache", "remove", "--force"], { timeoutMs: 10 * 60_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.invalidateCatalog();
    const message = lastWords(r.out);
    this.recent.push(`$ foundry cache remove --force (exit ${r.code})${message ? `\n  ${message}` : ""}`);
    return { ok: r.code === 0, message: message || (r.code === 0 ? "All cached models removed." : `exit ${r.code}`) };
  }

  /** `server` (0.12) or `service` (older); the second is tried only when the group is unknown. */
  private async runServer(action: string, extra: string[], timeoutMs: number): Promise<{ code: number; out: string; group: string }> {
    for (const group of ["server", "service"]) {
      const r = await this.run([group, action, ...extra], { timeoutMs }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
      if (!/unknown command|unrecognized/i.test(r.out)) return { ...r, group };
    }
    return { code: 1, out: "this version of Foundry Local does not know a server command", group: "server" };
  }

  /** The daemon state, port, process id, uptime and log location Foundry reports. */
  async serverStatus(): Promise<FoundryServerStatus | null> {
    const json = await this.runServer("status", ["-o", "json"], 20_000);
    if (json.code === 0) {
      const parsed = parseServerStatusJson(parseJsonOutput(json.out));
      if (parsed) return parsed;
    }
    const text = await this.runServer("status", [], 20_000);
    if (text.code !== 0) return null;
    return parseServerStatusText(text.out);
  }

  /**
   * Start, stop or restart the daemon. A blank port is omitted so Foundry uses its
   * configured value (or picks one); the address is always read back from its status.
   */
  async serverAction(
    action: "start" | "stop" | "restart",
    opts: { port?: number | null; idleTimeoutMinutes?: number | null } = {}
  ): Promise<FoundryServerActionResult> {
    const extra: string[] = [];
    if (opts.port !== undefined && opts.port !== null) {
      if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65_535) {
        return { ok: false, message: "The port must be a whole number from 0 to 65535 (0 asks Windows for a free port).", server: await this.serverStatus().catch(() => null) };
      }
      extra.push("--port", String(opts.port));
    }
    if (opts.idleTimeoutMinutes !== undefined && opts.idleTimeoutMinutes !== null) {
      if (!Number.isInteger(opts.idleTimeoutMinutes) || opts.idleTimeoutMinutes < 0) {
        return { ok: false, message: "The idle timeout must be 0 (keep running) or a whole number of minutes.", server: await this.serverStatus().catch(() => null) };
      }
      extra.push("--idle-timeout", String(opts.idleTimeoutMinutes));
    }
    const r = await this.runServer(action, extra, action === "stop" ? 30_000 : 90_000);
    this.recent.push(`$ foundry server ${action}${extra.length ? ` ${extra.join(" ")}` : ""} (exit ${r.code})`, ...ansi(r.out).trim().split(/\r?\n/).slice(-5).map((l) => `  ${l.slice(0, 200)}`));
    this.base = null;
    if (action !== "start") this.loaded = null;
    const server = await this.serverStatus().catch(() => null);
    if (server?.webUrls?.length) this.base = localUrl(server.webUrls[0]) ?? null;
    const message = lastWords(r.out);
    return {
      ok: r.code === 0 || !!server?.running,
      message: message || (r.code === 0 ? `The Foundry Local server was ${action === "stop" ? "stopped" : action === "restart" ? "restarted" : "started"}.` : `exit ${r.code}`),
      server
    };
  }

  /**
   * The full `foundry status` report: JSON first, its text otherwise. The text is
   * returned beside a null report so older versions can still be read by a person.
   */
  async diagnostics(): Promise<{ data: FoundryDiagnostics | null; text: string }> {
    const json = await this.run(["status", "-o", "json"], { timeoutMs: 120_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    if (json.code === 0) {
      const data = parseDiagnosticsJson(parseJsonOutput(json.out));
      if (data) return { data, text: "" };
    }
    const text = await this.run(["status"], { timeoutMs: 120_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    return { data: null, text: text.code === 0 ? ansi(text.out).trim() : lastWords(text.out) };
  }

  /**
   * Load the exact variant and say where to ask. Cancellable: an abort kills the
   * `foundry model load` child, unloads, and throws "cancelled".
   */
  async load(alias: string, wantedDevice: string | null, signal?: AbortSignal): Promise<LoadedFoundry> {
    const sel = await this.selectVariant(alias, wantedDevice);
    if ("error" in sel) throw new Error(sel.error);
    const base = await this.serviceUrl();
    const r = await this.run(["model", "load", sel.alias], { timeoutMs: 5 * 60_000, signal }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    if (signal?.aborted) {
      await this.unload().catch(() => undefined);
      throw new Error("cancelled");
    }
    this.recent.push(`$ foundry model load ${sel.alias} (exit ${r.code})`, ...r.out.split(/\r?\n/).slice(-6).map((l) => `  ${l.slice(0, 200)}`));
    if (r.code !== 0) {
      const reason = r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-4).join(" | ").slice(0, 400);
      throw new Error(`Foundry Local did not load ${sel.alias}: ${reason || `no answer (exit ${r.code})`}`);
    }
    const lv = loadedVariant(r.out);
    const ids = await this.fetchFn(`${base}/v1/models`).then((x) => x.json()).then((j: unknown) => { const data = (j as { data?: unknown } | null)?.data; return (Array.isArray(data) ? data.map((m: { id?: unknown }) => String(m.id)).filter(Boolean) : []) as string[]; }).catch(() => [] as string[]);
    const wanted = (lv?.variant ?? sel.alias).toLowerCase();
    const modelId = ids.find((i) => i.toLowerCase() === wanted) ?? ids.find((i) => i.toLowerCase().startsWith(wanted)) ?? ids.find((i) => i.toLowerCase().includes(sel.alias.toLowerCase())) ?? lv?.variant ?? sel.alias;
    const device = lv?.device ?? sel.device;
    if (wantedDevice && device && device.toUpperCase() !== wantedDevice.toUpperCase()) {
      // A device mismatch is REPORTED, not rebranded: the caller decides (the entry's
      // badge stays what was measured, and the answer says what actually ran).
      this.log(`Foundry loaded a ${device} build of ${sel.alias} although the ${wantedDevice} build was asked for: reporting the mismatch.`);
    }
    this.loaded = { endpoint: `${base}/v1`, modelId, device, variant: lv?.variant ?? "", alias: sel.alias };
    return this.loaded;
  }

  /** Download a catalog model into Foundry's own cache; progress lines reach `onLine` as the CLI prints them. */
  async download(alias: string, opts: { signal?: AbortSignal; onLine?: (line: string) => void } = {}): Promise<{ ok: boolean; error?: string }> {
    const r = await this.run(["model", "download", alias], { timeoutMs: 3 * 3600_000, signal: opts.signal, onLine: opts.onLine }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.invalidateCatalog();
    this.recent.push(`$ foundry model download ${alias} (exit ${r.code})`, ...ansi(r.out).trim().split(/\r?\n/).slice(-6).map((l) => `  ${l.slice(0, 200)}`));
    if (r.code !== 0) {
      if (opts.signal?.aborted) return { ok: false, error: "cancelled" };
      const reason = ansi(r.out).split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" | ").slice(0, 300);
      return { ok: false, error: reason || `no answer (exit ${r.code})` };
    }
    return { ok: true };
  }

  /** Remove a cached model from Foundry's own cache, unloading it first when it is in memory. */
  async remove(alias: string): Promise<{ ok: boolean; message: string }> {
    await this.unloadAlias(alias);
    const r = await this.run(["cache", "remove", alias, "--force"], { timeoutMs: 120_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.invalidateCatalog();
    const message = ansi(r.out).replace(/\s+/g, " ").trim().slice(0, 300);
    this.recent.push(`$ foundry cache remove ${alias} --force (exit ${r.code})${message ? `\n  ${message}` : ""}`);
    return { ok: r.code === 0, message: message || (r.code === 0 ? `removed ${alias}` : `exit ${r.code}`) };
  }

  private async unloadAlias(alias: string): Promise<void> {
    await this.run(["model", "unload", alias], { timeoutMs: 60_000 }).catch(() => undefined);
    if (this.loaded?.alias.toLowerCase() === alias.toLowerCase()) this.loaded = null;
  }

  /**
   * Details of one catalog model, including the execution provider of every variant.
   * JSON first; older versions print a Field/Value table (no variants) instead.
   */
  async modelInfo(alias: string): Promise<{ info: FoundryModelInfo | null; text: string }> {
    const a = String(alias ?? "").trim();
    if (!a) return { info: null, text: "" };
    const json = await this.run(["model", "info", a, "-o", "json"], { timeoutMs: 60_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    if (json.code === 0) {
      const info = parseModelInfoJson(parseJsonOutput(json.out));
      if (info) return { info, text: "" };
    }
    const text = await this.run(["model", "info", a], { timeoutMs: 60_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    const clean = ansi(text.out).trim();
    return { info: text.code === 0 ? parseModelInfoText(clean) : null, text: clean };
  }

  /**
   * Register a compatible ONNX Runtime GenAI folder without copying it. The task
   * is required; metadata is optional. Foundry validates the folder itself.
   */
  async registerModel(input: FoundryRegisterInput): Promise<FoundryActionResult> {
    const path = String(input?.path ?? "").trim();
    const modelId = String(input?.modelId ?? "").trim();
    const task = String(input?.task ?? "").trim();
    if (!path) return { ok: false, message: "Choose the model folder first." };
    if (path.length > 2_000) return { ok: false, message: "The model folder path is too long." };
    if (!/^[^\s:]+:[^\s:]+$/.test(modelId)) return { ok: false, message: "The model ID must be in <name>:<version> form, for example my-model:1." };
    if (!FOUNDRY_REGISTER_TASKS.includes(task as FoundryRegisterTask)) {
      return { ok: false, message: `The task must be one of: ${FOUNDRY_REGISTER_TASKS.join(", ")}.` };
    }
    const args = ["model", "register", path, modelId, "--task", task];
    const displayName = String(input?.displayName ?? "").trim();
    if (displayName) args.push("--display-name", displayName.slice(0, 200));
    const device = String(input?.device ?? "").trim().toLowerCase();
    if (device) {
      if (!/^(cpu|gpu|npu)$/.test(device)) return { ok: false, message: "The device must be cpu, gpu or npu." };
      args.push("--device", device);
    }
    const ep = String(input?.executionProvider ?? "").trim();
    if (ep) args.push("--execution-provider", ep.slice(0, 200));
    if (input?.contextLength !== undefined && input?.contextLength !== null) {
      const n = Number(input.contextLength);
      if (!Number.isInteger(n) || n <= 0) return { ok: false, message: "The context length must be a positive whole number of tokens." };
      args.push("--context-length", String(n));
    }
    const r = await this.run(args, { timeoutMs: 120_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.invalidateCatalog();
    this.recent.push(`$ foundry model register "${path}" ${modelId} --task ${task} (exit ${r.code})`, ...ansi(r.out).trim().split(/\r?\n/).slice(-4).map((l) => `  ${l.slice(0, 200)}`));
    return {
      ok: r.code === 0,
      message: lastWords(r.out) || (r.code === 0 ? `Registered ${modelId}. Its files stay where they are.` : `exit ${r.code}`)
    };
  }

  /** Remove a local registration. The model's files are not deleted. */
  async unregisterModel(alias: string): Promise<FoundryActionResult> {
    const a = String(alias ?? "").trim();
    if (!a) return { ok: false, message: "Name the model or model ID to unregister." };
    const r = await this.run(["model", "unregister", a, "--yes"], { timeoutMs: 120_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    this.invalidateCatalog();
    if (this.loaded?.alias.toLowerCase() === a.toLowerCase()) this.loaded = null;
    this.recent.push(`$ foundry model unregister ${a} --yes (exit ${r.code})`, ...ansi(r.out).trim().split(/\r?\n/).slice(-4).map((l) => `  ${l.slice(0, 200)}`));
    return {
      ok: r.code === 0,
      message: lastWords(r.out) || (r.code === 0 ? `Unregistered ${a}. Its files were left in place.` : `exit ${r.code}`)
    };
  }

  /** Load a cached build into the running daemon, choosing its device when one is named. */
  async loadModel(alias: string, device?: string | null): Promise<FoundryActionResult> {
    try {
      const loaded = await this.load(alias, device ?? null);
      return {
        ok: true,
        message: `Loaded ${loaded.alias} on ${loaded.device}${loaded.variant ? ` (${loaded.variant})` : ""}.`
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** Unload one model from the running daemon. */
  async unloadModel(alias: string): Promise<FoundryActionResult> {
    const a = String(alias ?? "").trim();
    if (!a) return { ok: false, message: "Name the model to unload." };
    await this.unloadAlias(a);
    return { ok: true, message: `Unloaded ${a}.` };
  }

  /**
   * One-shot file transcription through Foundry's speech models. The model must be
   * cached; installation stays in the Models library. `-f` is required for JSON.
   */
  async transcribe(input: { file: string; model?: string; language?: string }): Promise<{ ok: boolean; text?: string; error?: string }> {
    const file = String(input?.file ?? "").trim();
    if (!file) return { ok: false, error: "Choose an audio file first." };
    if (file.length > 2_000) return { ok: false, error: "The audio file path is too long." };
    const args = ["transcribe", "-f", file];
    const model = String(input?.model ?? "").trim();
    if (model) args.push("-m", model.slice(0, 200));
    const language = String(input?.language ?? "").trim();
    if (language) args.push("-l", language.slice(0, 40));
    args.push("-o", "json");
    const r = await this.run(args, { timeoutMs: 30 * 60_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    const clean = ansi(r.out).trim();
    this.recent.push(`$ foundry transcribe -f "${file}" (exit ${r.code})`);
    if (r.code !== 0) return { ok: false, error: lastWords(r.out) || `no answer (exit ${r.code})` };
    const parsed = parseJsonOutput(clean);
    const obj = asRecord(parsed);
    const text = typeof parsed === "string"
      ? parsed
      : asString(obj?.text) ?? asString(obj?.transcription) ?? asString(obj?.transcript) ?? clean;
    return { ok: true, text: text.trim() };
  }

  /** Run `foundry report` to open a pre-filled GitHub issue with diagnostics. */
  async foundryReport(): Promise<{ ok: boolean; message: string }> {
    const r = await this.run(["report"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, out: String((e as Error).message) }));
    const clean = ansi(r.out).trim();
    this.recent.push(`$ foundry report (exit ${r.code})`);
    if (r.code === 0) {
      return { ok: true, message: clean || "GitHub issue opened" };
    }
    return { ok: false, message: clean || `exit ${r.code}` };
  }

  /** What Foundry says is in memory: the documented endpoint when this version serves it, else the cache table's Loaded column. */
  async loadedModels(requireInventory = false): Promise<string[]> {
    if (this.base) {
      const j = await this.fetchFn(`${this.base}/openai/loadedmodels`, { signal: AbortSignal.timeout(3_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (Array.isArray(j)) {
        const names = j.flatMap((x) => {
          const m = x as { modelId?: unknown; id?: unknown; alias?: unknown } | null;
          const name = typeof x === "string" ? x : m?.modelId ?? m?.id ?? m?.alias;
          return typeof name === "string" && name.trim() ? [name] : [];
        });
        if (!requireInventory || names.length === j.length) return names;
      }
    }
    const list = await this.cached(requireInventory).catch(() => null);
    if (requireInventory && !list) throw new Error("Foundry Local could not report its loaded models.");
    return (list ?? []).filter((v) => v.loaded).map((v) => v.alias);
  }

  async releaseForHandoff(): Promise<void> {
    const loaded = await this.loadedModels(true);
    if (!this.loaded && !loaded.length) return;
    await this.unloadKnown(loaded);
    const remaining = await this.loadedModels(true);
    if (remaining.length) throw new Error(`Foundry Local still has these models loaded: ${remaining.join(", ")}.`);
  }

  /** Unload only when something is in memory: an idle daemon someone else started is left alone. */
  async unloadIfLoaded(): Promise<boolean> {
    const loaded = await this.loadedModels().catch(() => [] as string[]);
    if (!this.loaded && !loaded.length) return false;
    await this.unload();
    return true;
  }

  /**
   * Unload everything this host or Foundry says is in memory, then stop the daemon (it keeps
   * gigabytes of RAM after an unload). Models loaded outside this app are included: their
   * memory is what the other engine would need.
   */
  async unload(): Promise<void> {
    const loaded = await this.loadedModels().catch(() => [] as string[]);
    await this.unloadKnown(loaded);
  }

  private async unloadKnown(loaded: string[]): Promise<void> {
    const alias = this.loaded?.alias;
    this.loaded = null;
    this.base = null;
    const names = new Set<string>([...(alias ? [alias] : []), ...loaded]);
    for (const name of names) await this.run(["model", "unload", name], { timeoutMs: 60_000 }).catch(() => undefined);
    // stop whichever group this version knows; the other errors harmlessly
    await this.run(["server", "stop"], { timeoutMs: 30_000 }).catch(() => undefined);
    await this.run(["service", "stop"], { timeoutMs: 30_000 }).catch(() => undefined);
  }

  /** A short status line for the UI: version, loaded build, device. */
  statusLine(): string {
    if (!this.features.anyFeatureKnown) return "not installed";
    const l = this.loaded;
    return `${this.features.label}${l ? ` · loaded ${l.alias} (${l.device}${l.variant ? `, ${l.variant}` : ""})` : " · idle"}`;
  }
}
