/**
 * The sidecar wire protocol: one JSON value per line, shared by the Node sidecar and the
 * Tauri host that supervises it.
 *
 * Messages flow both ways:
 *  - Host → sidecar `req` (an MkmnApi call), answered by a `res` with the same id.
 *  - Sidecar → host `req` (a host capability the sidecar has no native UI for, e.g. a folder
 *    picker), answered by a host `res` with the same id.
 *  - Sidecar → host `event` (progress, streaming) with no reply.
 */

export interface SidecarRequest {
  t: "req";
  id: string;
  method: string;
  args: unknown[];
}

export interface SidecarResponse {
  t: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface SidecarEvent {
  t: "event";
  name: string;
  payload: unknown;
}

export type SidecarMessage = SidecarRequest | SidecarResponse | SidecarEvent;

/** One message as one line: line breaks inside strings are escaped by JSON.stringify itself. */
export function encodeMessage(m: SidecarMessage): string {
  return JSON.stringify(m);
}

/** One line as one message; null for a blank or unparseable line (never thrown). */
export function decodeLine(line: string): SidecarMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed) as SidecarMessage;
    if (!raw || typeof raw !== "object" || typeof (raw as SidecarMessage).t !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export type SidecarHandler = (...args: any[]) => Promise<unknown> | unknown;
export type HostCaller = (method: string, args: unknown[]) => Promise<unknown>;

let hostCallCounter = 0;
const nextHostCallId = () => `h-${Date.now().toString(36)}-${(hostCallCounter++).toString(36)}`;

/**
 * The method registry one sidecar serves. `dispatch` answers host requests and keeps the
 * in-flight table of the sidecar's own calls to the host, so the same object handles both
 * directions of the stdio conversation.
 */
export class SidecarDispatcher {
  private methods = new Map<string, SidecarHandler>();
  private hostWaiters = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  register(method: string, handler: SidecarHandler): void {
    this.methods.set(method, handler);
  }

  has(method: string): boolean {
    return this.methods.has(method);
  }

  /** Sends a request to the host and waits for its reply (e.g. a native folder picker). */
  callHost(send: (m: SidecarRequest) => void, method: string, args: unknown[] = [], timeoutMs = 600_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextHostCallId();
      const timer = setTimeout(() => {
        this.hostWaiters.delete(id);
        reject(new Error(`The host did not answer "${method}" in time.`));
      }, timeoutMs);
      this.hostWaiters.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      send({ t: "req", id, method, args });
    });
  }

  /** A reply from the host to a request this sidecar sent earlier. */
  resolveHostResponse(m: SidecarResponse): boolean {
    const waiter = this.hostWaiters.get(m.id);
    if (!waiter) return false;
    this.hostWaiters.delete(m.id);
    if (m.ok) waiter.resolve(m.result);
    else waiter.reject(new Error(m.error || `Host call ${m.id} failed.`));
    return true;
  }

  /** Handles one host request, answering with the response to write back (never throws). */
  async respond(m: SidecarRequest): Promise<SidecarResponse> {
    const handler = this.methods.get(m.method);
    if (!handler) {
      return { t: "res", id: m.id, ok: false, error: `Unknown sidecar method: ${m.method}` };
    }
    try {
      const args = Array.isArray(m.args) ? m.args : [];
      return { t: "res", id: m.id, ok: true, result: await handler(...args) };
    } catch (e) {
      return { t: "res", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
