import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The router's users in other MKMN instances. An instance that adopted another's router
 * writes `<pid>.json` ({ busy, at }) in a shared folder when a use starts and ends; the
 * instance that owns the server reads the folder before its idle stop. Its own idleness is
 * not the server's: the adopter's questions and benchmark probes went to a server stopped
 * under them. A file whose process is gone is removed. Only an adopter writes, two small
 * writes per use. A file of its own (not router.ts): the window imports router.ts, and this
 * reads and writes files.
 */
export class RouterUsers {
  private marked = false;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  constructor(private dir: () => string, o: { pid?: number; now?: () => number; alive?: (pid: number) => boolean } = {}) {
    this.pid = o.pid ?? process.pid;
    this.now = o.now ?? Date.now;
    this.alive = o.alive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } });
  }
  private file(pid: number): string { return path.join(this.dir(), `${pid}.json`); }
  /** This instance, an adopter, has `busy` uses running now. */
  mark(busy: number): void {
    try {
      fs.mkdirSync(this.dir(), { recursive: true });
      fs.writeFileSync(this.file(this.pid), JSON.stringify({ busy, at: this.now() }));
      this.marked = true;
    } catch { /* the owner then sees no use: it stops at its own idle window, as before */ }
  }
  /** This instance no longer uses another's router. */
  clear(): void {
    if (!this.marked) return;
    this.marked = false;
    try { fs.rmSync(this.file(this.pid), { force: true }); } catch { /* left for the owner to remove */ }
  }
  /** Whether another live instance is using the router now, or used it within `idleMs`. */
  othersActive(idleMs: number): boolean {
    let names: string[];
    try { names = fs.readdirSync(this.dir()); } catch { return false; }
    let active = false;
    for (const name of names) {
      const pid = Number(/^(\d+)\.json$/.exec(name)?.[1]);
      if (!pid || pid === this.pid) continue;
      if (!this.alive(pid)) { try { fs.rmSync(path.join(this.dir(), name), { force: true }); } catch { /* next time */ } continue; }
      try {
        const u = JSON.parse(fs.readFileSync(path.join(this.dir(), name), "utf8")) as { busy?: unknown; at?: unknown };
        if ((typeof u.busy === "number" && u.busy > 0) || (typeof u.at === "number" && this.now() - u.at < idleMs)) active = true;
      } catch { /* a file being written: read again at the next window */ }
    }
    return active;
  }
}
