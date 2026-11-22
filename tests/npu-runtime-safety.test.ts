import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, RequestListener, Server } from "node:http";
import { ServerManager } from "../src/core/server";
import { downloadFile } from "../src/core/download";

const managers: ServerManager[] = [];
const folders: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map((m) => m.stop()));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manager(extra: Partial<ConstructorParameters<typeof ServerManager>[0]> = {}) {
  const children: any[] = [];
  const spawnFn = (() => {
    const child: any = new EventEmitter();
    child.pid = undefined; // no real process, and no taskkill during this isolated test
    child.exitCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit("close", 0));
      return true;
    };
    children.push(child);
    return child;
  }) as any;
  const m = new ServerManager({
    exe: "not-a-real-runtime", spawnFn, pollMs: 1, readyTimeoutMs: 100,
    fetchFn: (async () => ({ ok: true })) as any,
    ...extra
  });
  managers.push(m);
  return { m, children };
}

describe("NPU process ownership (orchestration, not hardware tests)", () => {
  it("coalesces concurrent starts for the same context into one child", async () => {
    const { m, children } = manager();
    await Promise.all([m.start(4096), m.start(4096), m.start(4096)]);
    expect(children).toHaveLength(1);
    expect(m.status().state).toBe("ready");
  });

  it("stops the previous child before changing context", async () => {
    const { m, children } = manager();
    await Promise.all([m.start(4096), m.start(8192)]);
    expect(children).toHaveLength(2);
    expect(children[0].exitCode).toBe(0);
    expect(children[1].exitCode).toBeNull();
    expect(m.status().nctx).toBe(8192);
  });

  it("does not launch a queued start after an explicit stop", async () => {
    const { m, children } = manager();
    const start = m.start(4096);
    const rejected = expect(start).rejects.toThrow("cancelled");
    await m.stop();
    await rejected;
    expect(children).toHaveLength(0);
    expect(m.status().state).toBe("stopped");
  });

  it("invalidates the old crash-restart timer when a new start succeeds", async () => {
    const { m, children } = manager();
    await m.start(4096);
    children[0].exitCode = 1;
    children[0].emit("close", 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await m.start(8192);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(children).toHaveLength(2);
    expect(m.status().nctx).toBe(8192);
  });

  it("allows retry after a failed queued operation", async () => {
    const { m, children } = manager();
    const cancelled = m.start(4096);
    const rejected = expect(cancelled).rejects.toThrow("cancelled");
    await m.stop();
    await rejected;
    await m.start(8192);
    expect(children).toHaveLength(1);
    expect(m.status().state).toBe("ready");
  });

  it("bounds a stalled readiness fetch so shutdown can finish", async () => {
    const { m } = manager();
    // This injected fetch deliberately ignores AbortSignal; the deadline must still hold.
    (m as any).o.fetchFn = () => new Promise(() => undefined);
    m.on("error", () => undefined);
    const start = m.start(4096);
    const rejected = expect(start).rejects.toThrow("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await m.stop();
    await rejected;
    expect(m.status().state).toBe("stopped");
  });

  it("refuses replacement when the previous process never confirms exit", async () => {
    const { m, children } = manager();
    await m.start(4096);
    const child = children[0];
    const kill = child.kill;
    child.kill = () => true;
    vi.useFakeTimers();
    const start = m.start(8192);
    const rejected = expect(start).rejects.toThrow("Could not confirm");
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
    expect(children).toHaveLength(1);
    expect(m.status().state).toBe("failed");
    child.kill = kill;
    vi.useRealTimers();
  });

  it("re-issues the kill by the platform it is given, whatever system runs the test", async () => {
    // the host pretends to be Linux; the manager is told it runs the Windows kill policy
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: process.platform === "win32" ? "linux" : process.platform });
    try {
      const { m, children } = manager({ platform: "win32" });
      await m.start(4096);
      const child = children[0];
      let kills = 0;
      child.kill = () => {
        if (++kills >= 3) { child.exitCode = 0; queueMicrotask(() => child.emit("close", 0)); }
        return true;
      };
      vi.useFakeTimers();
      const start = m.start(8192);
      const settled = start.then(() => "ready", (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(16000);
      expect(await settled).toBe("ready");
      expect(kills).toBe(3);
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });

  it("confirms the exit of a wedged process once a re-issued kill acts", async () => {
    // the Windows kill policy (taskkill, re-issued every 5 s), injected so the test holds on every system
    const { m, children } = manager({ platform: "win32" });
    await m.start(4096);
    const child = children[0];
    const kill = child.kill;
    let kills = 0;
    child.kill = () => {
      kills++;
      if (kills >= 3) {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("close", 0));
      }
      return true;
    };
    vi.useFakeTimers();
    const start = m.start(8192);
    await vi.advanceTimersByTimeAsync(11000);
    await start;
    expect(kills).toBe(3); // the first two taskkills did not act; the third did
    expect(children).toHaveLength(2);
    expect(m.status().state).toBe("ready");
    child.kill = kill;
    vi.useRealTimers();
  });
});

async function downloadFixture(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const folder = mkdtempSync(join(tmpdir(), "mkmn-download-"));
  folders.push(folder);
  return { url: `http://127.0.0.1:${address.port}/bundle`, dest: join(folder, "runtime.zip") };
}

describe("runtime download resumption", () => {
  // 2026-11-17 review: the downloader took http as readily as https, and followed a redirect down to http.
  // Every hop, redirects included, goes through the same check at the top of `get`.
  it("refuses a plain-http address before connecting", async () => {
    let hits = 0;
    const { url, dest } = await downloadFixture((_req, res) => { hits++; res.writeHead(200, { "Content-Length": 2 }); res.end("ok"); });
    await expect(downloadFile(url, dest, () => undefined)).rejects.toThrow(/only https/);
    expect(hits).toBe(0);
    const src = readFileSync("src/core/download.ts", "utf8");
    expect(src).toMatch(/redirects > 6.*\r?\n.*only https/);
  });

  it("restarts an unsatisfiable partial instead of promoting it", async () => {
    const ranges: Array<string | undefined> = [];
    const { url, dest } = await downloadFixture((req, res) => {
      ranges.push(req.headers.range);
      if (req.headers.range) { res.writeHead(416); res.end(); }
      else { res.writeHead(200, { "Content-Length": 8 }); res.end("complete"); }
    });
    writeFileSync(dest + ".part", "wrong old file");
    await downloadFile(url, dest, () => undefined, undefined, { allowHttp: true });
    expect(ranges).toEqual(["bytes=14-", undefined]);
    expect(readFileSync(dest, "utf8")).toBe("complete");
  });

  it("rejects a mismatched Content-Range without changing the destination", async () => {
    const { url, dest } = await downloadFixture((_req, res) => {
      res.writeHead(206, { "Content-Range": "bytes 0-2/6", "Content-Length": 3 });
      res.end("bad");
    });
    writeFileSync(dest, "previous");
    writeFileSync(dest + ".part", "abc");
    await expect(downloadFile(url, dest, () => undefined, undefined, { allowHttp: true })).rejects.toThrow("Content-Range");
    expect(readFileSync(dest, "utf8")).toBe("previous");
    expect(readFileSync(dest + ".part", "utf8")).toBe("abc");
  });

  it("appends a valid resumed response", async () => {
    const { url, dest } = await downloadFixture((_req, res) => {
      res.writeHead(206, { "Content-Range": "bytes 3-5/6", "Content-Length": 3 });
      res.end("def");
    });
    writeFileSync(dest + ".part", "abc");
    await downloadFile(url, dest, () => undefined, undefined, { allowHttp: true });
    expect(readFileSync(dest, "utf8")).toBe("abcdef");
  });

  it("fails explicitly when a fresh request returns 416", async () => {
    const { url, dest } = await downloadFixture((_req, res) => {
      res.writeHead(416); res.end();
    });
    writeFileSync(dest, "previous");
    await expect(downloadFile(url, dest, () => undefined, undefined, { allowHttp: true })).rejects.toThrow("416");
    expect(readFileSync(dest, "utf8")).toBe("previous");
  });

  it("does not promote a valid-looking but unfinished response range", async () => {
    const { url, dest } = await downloadFixture((_req, res) => {
      res.writeHead(206, { "Content-Range": "bytes 3-4/8" });
      res.end("de");
    });
    writeFileSync(dest, "previous");
    writeFileSync(dest + ".part", "abc");
    await expect(downloadFile(url, dest, () => undefined, undefined, { allowHttp: true })).rejects.toThrow("Content-Range");
    expect(readFileSync(dest, "utf8")).toBe("previous");
  });

  it("checks actual resumed byte count even without Content-Length", async () => {
    const { url, dest } = await downloadFixture((_req, res) => {
      res.writeHead(206, { "Content-Range": "bytes 3-7/8" });
      res.end("de");
    });
    writeFileSync(dest, "previous");
    writeFileSync(dest + ".part", "abc");
    await expect(downloadFile(url, dest, () => undefined, undefined, { allowHttp: true })).rejects.toThrow("incomplete byte range");
    expect(readFileSync(dest, "utf8")).toBe("previous");
  });
});
