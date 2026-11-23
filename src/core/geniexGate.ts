/**
 * The minimum GenieX this app runs inference with, and the one check every GenieX consumer passes through.
 *
 * GenieX v0.11.0 is the first release whose behaviour the app depends on (the `/status` route of a busy server,
 * `usage.prompt_tokens` counting the whole prompt, the QAIRT 4.0 context format the native bundles need). An older
 * CLI, or one whose `--version` cannot be read, is refused BEFORE any server is started or adopted. The check only
 * runs the local executable: an offline PC with a compatible GenieX keeps working.
 *
 * The Rust host holds the same number (`GENIEX_MIN_VERSION` in `src-tauri/src/capabilities.rs`); a test reads both.
 */

export const GENIEX_MIN_VERSION = "0.11.0";

export type GeniexGateState = "ok" | "missing" | "outdated" | "invalid";

export interface GeniexGateStatus {
  state: GeniexGateState;
  /** The geniex.exe that was checked, or null when none was found. */
  path: string | null;
  /** The version it reported ("0.11.0"), or null when it reported none. */
  detected: string | null;
  required: string;
  /** One sentence for the person: what was found, what is needed, what to do. */
  message: string;
}

/**
 * The CLI version in what `geniex --version` prints ("GenieX CLI Version:     v0.11.0", then the QAIRT and llama.cpp
 * lines, which must never be read as the CLI's version). A bare "v0.11.0" line is accepted too, and words after the
 * version ("(build 93cf736)") are ignored. Null when no line names it as x.y.z. The Rust host reads the same lines the
 * same way: both are tested on `src/shared/geniexVersionLines.json`.
 */
export function parseGeniexCliVersion(text: string | null | undefined): string | null {
  if (!text) return null;
  // eslint-disable-next-line no-control-regex -- strips ANSI colour codes from the console output
  const clean = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  for (const line of clean.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:geniex(?:\s+cli)?\s+version\s*:\s*)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:\s.*)?$/i);
    if (m) return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
  }
  return null;
}

/** -1, 0 or 1 for two x.y.z strings. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
  return 0;
}

/** The verdict for one executable and what it printed for `--version`. */
export function judgeGeniex(path: string | null, versionOutput: string | null, required = GENIEX_MIN_VERSION): GeniexGateStatus {
  if (!path) {
    return { state: "missing", path: null, detected: null, required, message: `GenieX is not installed. MKMN needs GenieX v${required} or newer to run models on the NPU: install it from the setup screen or Settings → Developer → Runtime.` };
  }
  const detected = parseGeniexCliVersion(versionOutput);
  if (!detected) {
    return { state: "invalid", path, detected: null, required, message: `The GenieX at ${path} did not report a valid version. MKMN needs GenieX v${required} or newer: reinstall it from the setup screen or Settings → Developer → Runtime.` };
  }
  if (compareVersions(detected, required) < 0) {
    return { state: "outdated", path, detected, required, message: `GenieX v${detected} is installed, and MKMN needs v${required} or newer. Update it from the setup screen or Settings → Developer → Runtime.` };
  }
  return { state: "ok", path, detected, required, message: `GenieX v${detected} (v${required} or newer is required).` };
}

export interface GeniexGateDeps {
  /** The geniex.exe the app would run (saved path, environment, then the usual folder). */
  find(): string | null;
  /** What `geniex --version` printed, or null when it did not answer. */
  readVersion(exe: string): Promise<string | null>;
  /** Size and modification time, so an executable replaced in place is checked again. */
  identity(exe: string): string | null;
}

/**
 * The cached gate: one `--version` per executable identity (path, size, time). A GenieX updated in place, or a new
 * saved path, is checked again; a GenieX that did not answer is asked again on the next call.
 */
export class GeniexGate {
  private cache: { key: string; status: GeniexGateStatus } | null = null;
  private pending: { key: string; p: Promise<GeniexGateStatus> } | null = null;

  constructor(private deps: GeniexGateDeps) {}

  /** The last verdict, without running anything (null before the first check). */
  last(): GeniexGateStatus | null { return this.cache?.status ?? null; }

  async check(): Promise<GeniexGateStatus> {
    const exe = this.deps.find();
    if (!exe) {
      const status = judgeGeniex(null, null);
      this.cache = { key: "", status };
      return status;
    }
    const key = `${exe}|${this.deps.identity(exe) ?? ""}`;
    if (this.cache?.key === key && this.cache.status.state !== "invalid") return this.cache.status;
    if (this.pending?.key === key) return this.pending.p;
    const p = this.deps.readVersion(exe).catch(() => null).then((out) => {
      const status = judgeGeniex(exe, out);
      this.cache = { key, status };
      return status;
    }).finally(() => { if (this.pending?.key === key) this.pending = null; });
    this.pending = { key, p };
    return p;
  }

  /** The executable when it may run inference; throws the person-facing message otherwise. */
  async require(): Promise<string> {
    const s = await this.check();
    if (s.state !== "ok" || !s.path) throw new Error(s.message);
    return s.path;
  }

  /** The executable when it may run inference, else null (callers that fall back quietly, like the router). */
  async usable(): Promise<string | null> {
    const s = await this.check();
    return s.state === "ok" ? s.path : null;
  }

  /** Forget the verdict (after an install or a new saved path). */
  reset() { this.cache = null; this.pending = null; }
}
