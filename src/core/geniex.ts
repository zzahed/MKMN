import { ChildProcess, spawn, execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { FriendlyError, InstalledModel, InstallProgress } from "../shared/types";
import { friendly, isNoise } from "./errors";

export const DEFAULT_ENDPOINT = "http://127.0.0.1:18181/v1";

/** %LOCALAPPDATA%\GenieX CLI\geniex.exe, or an explicit override. */
export function findGeniex(override: string | null, env = process.env, exists = fs.existsSync): string | null {
  const candidates: string[] = [];
  // an override (a saved setting the webview can write, or the environment) may only name geniex.exe
  const isGeniex = (p: string) => path.basename(p).toLowerCase() === "geniex.exe";
  if (override && isGeniex(override)) candidates.push(override);
  if (env.GENIEX_PATH && isGeniex(env.GENIEX_PATH)) candidates.push(env.GENIEX_PATH);
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "GenieX CLI", "geniex.exe"));
  // without LOCALAPPDATA (a process started with a bare environment) the user profile holds the same folder,
  // the fallback the app's own paths use (mkmnPaths): "GenieX is not installed" was said of an installed GenieX
  if (env.USERPROFILE) candidates.push(path.join(env.USERPROFILE, "AppData", "Local", "GenieX CLI", "geniex.exe"));
  return candidates.find((c) => exists(c)) ?? null;
}

export function modelsDir(env = process.env): string {
  const home = env.USERPROFILE ?? env.HOME ?? "";
  return path.join(env.GENIEX_DATADIR ?? path.join(home, ".cache", "geniex"), "models");
}

export function run(exe: string, args: string[], timeoutMs = 30000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code as number) || 1 : 0;
      resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
    });
  });
}

/**
 * `--skip-update` for a `geniex serve` this process starts, read from the same setting as the host's servers
 * (`geniexUpdateCheck`, off by default): sent only when the check is off and the installed help names the flag
 * as a whole word, so an older GenieX that does not know it is never refused a start.
 */
export function updateProbeArgs(updateCheck: boolean | undefined, serveHelp: string): string[] {
  if (updateCheck === true) return [];
  return /(^|[^\w-])--skip-update(?![\w-])/m.test(serveHelp) ? ["--skip-update"] : [];
}

export async function geniexVersion(exe: string): Promise<string | null> {
  const r = await run(exe, ["version"], 10000);
  if (r.code !== 0) return null;
  return r.out.trim().split(/\r?\n/)[0] || null;
}

/** Precision tokens a cache list names ("Q4_0", "Q4_K_M", "W4A16", "IQ4_XS", "F16"…). */
const PRECISION_TOKEN = /\b(Q\d[\w.]*|IQ\d[\w.]*|W\dA\d+|F16|FP16|BF16|F32|FP32|MXFP4[A-Za-z]*)\b/g;

/**
 * Output format of `geniex list` is not documented; accept "name [size] [precisions]" lines and
 * ignore decoration. The installed CLI (0.10.0) prints a `NAME | SIZE | PRECISIONS` table whose
 * sizes use binary units (GiB / MiB) and whose precision column declares exactly which builds are
 * downloaded — one precision's repository directory must never stand in for another precision.
 */
export function parseList(out: string): InstalledModel[] {
  const models: InstalledModel[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(name|model|-+|=+|no models)/i.test(line) || /name\s+size\s+precisions/i.test(line)) continue;
    const m = /([\w.-]+(?:\/[\w.-]+)+(?::[\w.-]+)?)/.exec(line);
    if (!m) continue;
    const size = /(\d+(?:\.\d+)?)\s*(GiB|MiB|GB|MB)/i.exec(line);
    // GiB / MiB are binary units and every size in the installed CLI's output is one of
    // them; decimal GB / MB are accepted for older or localized outputs.
    const isBinary = size ? /^(GiB|MiB)$/i.test(size[2]) : false;
    const isBig = size ? /^G/i.test(size[2]) : false;
    const value = size ? parseFloat(size[1]) : NaN;
    const sizeGB = !size ? undefined : isBig ? (isBinary ? value * 1.073741824 : value) : (isBinary ? value * 1.073741824 / 1024 : value / 1024);
    // The precision suffix of the ref itself ("<repo>:<precision>"), when the line carries one.
    const refPrecision = /:([^:/]+)$/.exec(m[1])?.[1];
    const precisions = [...line.matchAll(PRECISION_TOKEN)].map((x) => x[1].toUpperCase());
    models.push({
      name: m[1],
      ref: m[1],
      ...(sizeGB !== undefined ? { sizeGB: Math.round(sizeGB * 100) / 100 } : {}),
      ...(refPrecision || precisions.length ? { precisions: [...new Set([refPrecision, ...precisions].filter((p): p is string => !!p).map((p) => p.toUpperCase()))] } : {})
    });
  }
  return models;
}

/**
 * The installed models, or an error: a failed `geniex list` must never read as an
 * empty inventory (it made the app re-install cached models and mis-own cleanup).
 */
export async function listInstalled(exe: string): Promise<InstalledModel[]> {
  const r = await run(exe, ["list"]);
  if (r.code !== 0 && !r.out.trim()) {
    throw new Error(`geniex list failed (exit ${r.code})`);
  }
  const parsed = parseList(r.out);
  // A clean exit that printed no model rows is a real empty cache; a nonzero exit
  // with decoration only ("cache path" banners) is treated as a failure unless the
  // table was parsed — the CLI exits nonzero when the cache cannot be read.
  if (r.code !== 0 && parsed.length === 0) throw new Error(`geniex list failed (exit ${r.code}): ${r.out.split(/\r?\n/).find((l) => l.trim())?.slice(0, 120) ?? "no output"}`);
  return parsed;
}

/** `geniex remove` may ask "are you sure?" on stdin, so an answer is always supplied rather than waiting for it. */
function runConfirmed(exe: string, args: string[], timeoutMs = 60000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as any).code as number) || 1 : 0;
      resolve({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
    });
    child.stdin?.on("error", () => { /* the command did not read its input */ });
    child.stdin?.end("y\n");
  });
}

/** The folder of a model under the models directory: `org/name`, `org--name` or `models--org--name` variants of its ref.
 * Safety contract for the fallback removal path (this list is fed to a recursive delete):
 *  - an empty or root-relative name selects NOTHING (never the cache root itself);
 *  - a name that carries a precision suffix (`org/model:q4_0`) only ever selects
 *    precision-specific folders: the shared repository directory may hold OTHER
 *    precisions of the same model, which this call was never asked to remove;
 *  - a candidate whose real path escapes the models directory (a symlink or reparse
 *    point pointing elsewhere) is dropped, even when its lexical path sits inside. */
export function modelFolders(name: string, dir = modelsDir(), exists = fs.existsSync): string[] {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return [];
  const hasPrecision = /:[^/:]*$/.test(trimmed);
  const base = trimmed.replace(/:[^/:]*$/, "");
  if (!base) return [];
  const flat = base.replace(/\//g, "--");
  if (!flat) return [];
  const precisionSpecific = trimmed.replace(/[/:]/g, "--");
  const names = hasPrecision
    ? [precisionSpecific, `models--${precisionSpecific}`]
    : [base, flat, `models--${flat}`];
  const inside = (p: string): boolean => {
    // Containment: a name that escapes the models directory (`../x`, a drive, a reparse
    // target outside) must never be deleted by the fallback removal path.
    const rel = path.relative(dir, p);
    return !!rel && rel !== "." && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const candidates = [...new Set(names)].map((n) => path.join(dir, n)).flatMap((p) => {
    if (!inside(p)) return [];
    if (exists(p)) return [p];
    // Canonical names are lower case; the cache keeps the publisher's spelling. On a
    // case-sensitive folder the exact path misses, so the one folder that matches apart
    // from case is used. Two such folders are ambiguous, and then nothing is selected.
    const folded = foldCase(dir, path.relative(dir, p));
    return folded && inside(folded) && exists(folded) ? [folded] : [];
  });
  if (candidates.length === 0) return [];
  // Real-path containment: a candidate must still resolve INSIDE the real models
  // directory. (The lexical check above cannot see a reparse point's target.)
  try {
    const realDir = fs.realpathSync(dir);
    return candidates.filter((p) => {
      try {
        const real = fs.realpathSync(p);
        const rel = path.relative(realDir, real);
        return !!rel && rel !== "." && !rel.startsWith("..") && !path.isAbsolute(rel);
      } catch {
        return false; // an existing path that cannot be resolved is not deletable safely
      }
    });
  } catch {
    return [];
  }
}

/** `rel` under `dir`, each segment spelt as it is on disk when exactly one entry matches it apart from case; null otherwise. */
function foldCase(dir: string, rel: string): string | null {
  let at = dir;
  for (const seg of rel.split(/[\\/]/).filter(Boolean)) {
    if (seg === "." || seg === "..") return null;
    let entries: string[];
    try { entries = fs.readdirSync(at); } catch { return null; }
    const hits = entries.filter((e) => e.toLowerCase() === seg.toLowerCase());
    if (hits.length !== 1) return null;
    at = path.join(at, hits[0]);
  }
  return at;
}

/** Terminal control sequences (cursor, colours, "?25l") and stray control characters, so an error reads as text. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\[\?\d+[a-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\ufffd]/g, "").replace(/\s+/g, " ").trim();
}

/** The flags that skip the "Are you sure?" prompt, tried in turn; the first the CLI accepts wins. */
const CONFIRM_FLAGS = ["--yes", "-y", "--force", "-f"];
const UNKNOWN_FLAG = /unknown|unrecognized|invalid (?:flag|option)|no such (?:flag|option)|usage:/i;

/** The same model under the names GenieX has used: an AI Hub bundle is `ai-hub-models/X` in the app's list and `qualcomm/X` in GenieX 0.9.3. */
/** The canonical model name/ref lives in the pure identity module
 * (`modelIdentity.ts`) so renderer code can import it without dragging node
 * built-ins into the browser bundle; re-exported here for the node-side users. */
import { canonicalName } from "./modelIdentity";
export { canonicalName };

/** The precision a cache reference or catalog entry asks for ("Q8_0"), upper-case; null when it names none. */
export function wantedPrecision(e: { repo: string; quant?: string | null }, ref?: string): string | null {
  const fromRef = ref?.includes("/") ? /:([^:/]+)$/.exec(ref)?.[1] : undefined;
  const p = e.quant ?? fromRef ?? null;
  return p ? p.toUpperCase() : null;
}

/**
 * Is this entry's exact build in the parsed cache? Three answers, because "no" and
 * "cannot know" lead to different cleanup decisions:
 *  - true: the repository is listed and, when it declares its downloaded precisions,
 *    the wanted precision is among them (Q4_0 on disk is not a Q8_0 install);
 *  - false: the inventory was read and the repository (in the wanted precision) is absent;
 *  - null: the inventory could not be read — nothing may be inferred, and nothing may
 *    be removed on this answer's behalf.
 */
export function installedState(e: { repo: string; quant?: string | null }, listed: InstalledModel[] | null, ref?: string): boolean | null {
  if (listed === null) return null;
  const repo = canonicalName(e.repo);
  if (!repo) return null;
  const want = wantedPrecision(e, ref);
  for (const m of listed) {
    // The listed name may carry a precision suffix ("org/model:Q4_0"): the identity
    // that must match the entry is its base repo, never the suffix.
    const mRepo = canonicalName(m.ref || m.name).replace(/:[^:]*$/, "");
    if (mRepo !== repo) continue;
    if (!want) return true;
    const declared = m.precisions;
    // A ref that names its precision ("<repo>:<prec>") is itself evidence of that precision.
    if ((m.ref || m.name).toLowerCase().includes(`:${want.toLowerCase()}`)) return true;
    if (declared?.length) return declared.some((p) => p.toUpperCase() === want);
    // The output declared no precisions at all and a precision was wanted: "cannot
    // know" — the old format must not stand in one precision for another.
    return null;
  }
  return false;
}
export const nameVariants = (ref: string): string[] => [...new Set([ref, ref.replace(/^ai-hub-models\//i, "qualcomm/"), ref.replace(/^qualcomm\//i, "ai-hub-models/")])];

export async function removeModel(exe: string, name: string, dir = modelsDir()): Promise<{ ok: boolean; out: string }> {
  if (!String(name ?? "").trim()) return { ok: false, out: "no model reference was given" };
  let last = { code: 1, out: "" };
  for (const flag of CONFIRM_FLAGS) {
    last = await runConfirmed(exe, ["remove", name, flag]);
    if (last.code === 0) return { ok: true, out: stripAnsi(last.out) };
    if (!UNKNOWN_FLAG.test(stripAnsi(last.out))) break; // it understood the flag and failed for another reason
  }
  // The command refused or failed: delete the model's own folder.
  const folders = modelFolders(name, dir);
  for (const f of folders) {
    // Belt and braces: the recursive delete below is the destructive step, so every
    // candidate is containment-checked again right before it, never trusting one check.
    const rel = path.relative(dir, f);
    if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    try { fs.rmSync(f, { recursive: true, force: true }); } catch (e) { return { ok: false, out: `${stripAnsi(last.out)} ${(e as Error).message}`.trim() }; }
  }
  if (folders.length) return { ok: true, out: stripAnsi(last.out) };
  return { ok: false, out: stripAnsi(last.out) || "geniex could not remove this model" };
}

export function parsePercent(line: string): number | null {
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(line);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return v >= 0 && v <= 100 ? v : null;
}

export interface Pull {
  cancel(): void;
  done: Promise<void>;
  /** True once cancel() was called: callers must not fall through to the next
   * provider/alias — a cancel is a cancel, not a failed provider. */
  readonly cancelled: boolean;
}

/** The documented `geniex pull` options MKMN can act on. */
export interface PullOptions {
  /** Model source, passed as `--model-hub` when the entry's source is known (auto-detection can misread a short docker name). */
  modelHub?: "aihub" | "hf" | "modelscope" | "docker" | "localfs";
  /** Local directory or AI Hub .zip, passed as `--local-path` (implies localfs). */
  localPath?: string;
  /** Model type, passed as `--model-type` when known. */
  modelType?: "llm" | "vlm";
}

/** The exact `geniex pull` argument list for a ref and its options. Pure, so tests pin it. */
export function pullArgs(ref: string, o: PullOptions | undefined): string[] {
  const args = ["pull", ref];
  if (o?.localPath) {
    args.push("--local-path", o.localPath);
  } else if (o?.modelHub) {
    args.push("--model-hub", o.modelHub);
  }
  if (o?.modelType) args.push("--model-type", o.modelType);
  return args;
}

/**
 * `geniex pull <ref>` with progress. The progress format is undocumented, so a percentage is
 * taken from any line that has one and the raw line is always passed on. Pull is resumable:
 * calling it again after cancel continues the download.
 */
export function pullModel(
  exe: string,
  ref: string,
  onProgress: (p: InstallProgress) => void,
  spawnFn: typeof spawn = spawn,
  options?: PullOptions
): Pull {
  let child: ChildProcess | null = null;
  let cancelled = false;
  let tail = "";
  const done = new Promise<void>((resolve) => {
    child = spawnFn(exe, pullArgs(ref, options), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "dumb", CI: "1", NO_COLOR: "1" } });
    // A native NPU bundle has no precision in its ref: GenieX lists the precisions and waits for a choice that nobody
    // gives it without a terminal. Enter takes the one it marks as the default; asked at most a few times.
    let answered = 0;
    let pendingAnswer: NodeJS.Timeout | null = null;
    const answerMenu = (text: string) => {
      if (answered >= 4 || pendingAnswer || !/precision|select|choose|❯|>\s*\w/i.test(text) || /\d\s*%/.test(text)) return;
      pendingAnswer = setTimeout(() => { pendingAnswer = null; answered++; try { child?.stdin?.write("\r\n"); } catch { /* the process already ended */ } }, 800);
    };
    const feed = (b: Buffer) => {
      answerMenu(b.toString("utf8"));
      for (const part of b.toString("utf8").split(/[\r\n]+/)) {
        const line = stripAnsi(part);
        if (!line) continue;
        tail = (tail + "\n" + line).slice(-4000);
        onProgress({ ref, phase: "downloading", percent: parsePercent(line), line });
      }
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (e) => {
      onProgress({ ref, phase: "error", percent: null, error: friendly(e.message) ?? undefined });
      resolve();
    });
    child.on("close", (code) => {
      if (pendingAnswer) clearTimeout(pendingAnswer);
      if (cancelled) onProgress({ ref, phase: "cancelled", percent: null });
      else if (code === 0) onProgress({ ref, phase: "done", percent: 100 });
      else onProgress({ ref, phase: "error", percent: null, error: friendly(tail) ?? { id: "pull", title: "Download failed", fix: "Check your connection and disk space, then try again; the download resumes.", raw: tail } });
      resolve();
    });
  });
  return {
    cancel() {
      cancelled = true;
      child?.kill();
    },
    get cancelled() {
      return cancelled;
    },
    done
  };
}

export function freeDiskGB(dir: string): number | null {
  try {
    let d = dir;
    while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    const s = (fs as any).statfsSync(d);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

/** Spec: disk-space check before install. Needs the file plus 15% headroom. */
export function diskCheck(freeGB: number | null, needGB: number): FriendlyError | null {
  if (freeGB === null) return null;
  if (freeGB < needGB * 1.15) {
    return {
      id: "disk",
      title: "Not enough disk space",
      fix: `This model needs about ${needGB.toFixed(1)} GB; only ${freeGB.toFixed(1)} GB is free. Free some space and retry.`,
      raw: ""
    };
  }
  return null;
}

export { isNoise };

/** The parsed `geniex config list` rows: key and value, tolerating both "key: value"
 *  and "key = value" spellings; anything else is passed through as a comment line. */
export function parseConfigList(out: string): { rows: { key: string; value: string }[]; other: string[] } {
  const rows: { key: string; value: string }[] = [];
  const other: string[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line) continue;
    const m = /^([\w.-]+)\s*[:=]\s*(.+)$/.exec(line);
    if (m) rows.push({ key: m[1], value: m[2].trim() });
    else other.push(line);
  }
  return { rows, other };
}

/** `geniex config list`: the CLI's stored configuration (chipset and friends), as text. */
export async function configList(exe: string): Promise<string> {
  const r = await run(exe, ["config", "list"]);
  if (r.code !== 0 && !r.out.trim()) throw new Error(`geniex config list failed (exit ${r.code})`);
  return stripAnsi(r.out);
}

/** `geniex model set-type <name> <llm|vlm>`: which path a cached model takes (a VLM
 *  loads its projector and takes image/audio input; an LLM runs text only). */
export async function setModelType(exe: string, name: string, type: "llm" | "vlm"): Promise<{ ok: boolean; out: string }> {
  const n = String(name ?? "").trim();
  if (!n) return { ok: false, out: "no model reference was given" };
  const r = await run(exe, ["model", "set-type", n, type], 60000);
  return { ok: r.code === 0, out: stripAnsi(r.out) };
}

/** `geniex clean`: remove ALL cached models. Destructive and confirmed twice by the UI;
 *  the CLI's own prompt is answered, its confirmation flags are tried in turn, and a
 *  CLI that refuses is reported — MKMN never falls back to deleting the cache itself. */
export async function cleanAll(exe: string): Promise<{ ok: boolean; out: string }> {
  let last = { code: 1, out: "" };
  const attempts: string[][] = [[], ...CONFIRM_FLAGS.map((f) => [f])];
  for (const extra of attempts) {
    last = await runConfirmed(exe, ["clean", ...extra], 300000);
    if (last.code === 0) return { ok: true, out: stripAnsi(last.out) };
    // A failure that is not "unknown flag" is a real refusal: report it, try nothing else.
    if (!UNKNOWN_FLAG.test(stripAnsi(last.out))) break;
  }
  return { ok: false, out: stripAnsi(last.out) || `geniex clean failed (exit ${last.code})` };
}

/** Every build the cache holds, named as GenieX serves it: the bare name and `name:precision` for each precision. */
export function installedRefsOf(list: { name?: string; ref?: string; precisions?: string[] }[]): string[] {
  return list.flatMap((m) => {
    const name = String(m.ref || m.name || "");
    if (!name) return [];
    const base = name.replace(/:[^:/]*$/, "");
    return [name, ...(m.precisions ?? []).map((p) => `${base}:${p}`).filter((r) => r !== name)];
  });
}
