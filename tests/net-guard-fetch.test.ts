import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * pinnedGet's whole download path, against a local plain-http server: each hop's refusal,
 * the redirect limit, the byte cap, the timeout and a connection that breaks.
 *
 * The guard refuses 127.0.0.1, so it can never connect to a local test server on its own.
 * The mock below lets the guard's own lookup run first (its checks and refusals are the
 * real ones) and only then sends a connection it ALLOWED to the local server. A refused
 * name therefore still never connects: `hits` stays at zero.
 */

const PUBLIC = "93.184.216.34";
let target = 0; // the local server's port, set per test

vi.mock("node:http", async (orig) => {
  const real = await orig<typeof import("node:http")>();
  const request = (url: URL, opts: any, cb: any) => {
    const guarded = opts.lookup;
    const lookup = (host: string, o: any, done: any) => guarded(host, o, (err: any, addr: any, fam: any) => {
      if (err) return done(err);
      if (Array.isArray(addr)) return done(null, [{ address: "127.0.0.1", family: 4 }]);
      return done(null, "127.0.0.1", 4, fam);
    });
    const routed = new URL(url);
    routed.port = String(target);
    return real.request(routed, { ...opts, lookup, headers: { ...opts.headers, Host: url.host } }, cb);
  };
  return { ...real, request, default: { ...real, request } };
});

// An https address goes through node:https. TLS is not the guard's work, so the test
// routes it to the same plain server (as http) and records that https was the one chosen.
const httpsCalls: string[] = [];
vi.mock("node:https", async (orig) => {
  const real = await orig<typeof import("node:https")>();
  const http = await import("node:http");
  const request = (url: URL, opts: any, cb: any) => {
    httpsCalls.push(String(url));
    const plain = new URL(url);
    plain.protocol = "http:";
    return (http.request as any)(plain, opts, cb);
  };
  return { ...real, request, default: { ...real, request } };
});

const { pinnedGet } = await import("../src/core/netGuard");

type Handler = (q: http.IncomingMessage, r: http.ServerResponse, n: number) => void;
let srv: http.Server;
let sockets: Socket[] = [];
let hits: string[] = [];
let handler: Handler = (_q, r) => r.end("ok");

beforeEach(async () => {
  hits = [];
  sockets = [];
  srv = http.createServer((q, r) => { hits.push(`${q.headers.host}${q.url}`); handler(q, r, hits.length); });
  srv.on("connection", (s) => sockets.push(s));
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  target = (srv.address() as AddressInfo).port;
});
afterEach(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((ok) => srv.close(() => ok()));
});

const lookups: string[] = [];
const lookup = async (host: string) => { lookups.push(host); return [{ address: PUBLIC, family: 4 }]; };
const opts = (over: object = {}) => ({ lookup, maxBytes: 1000, timeoutMs: 3000, allowHttp: true, ...over });
beforeEach(() => { lookups.length = 0; });

describe("pinnedGet reads a public address", () => {
  it("returns the status, headers and body, sending its own User-Agent", async () => {
    let ua: string | undefined;
    handler = (q, r) => { ua = q.headers["user-agent"]; r.setHeader("x-k", "v"); r.end("hello"); };
    const res = await pinnedGet("http://pub.test/a.js", opts());
    expect(res).toMatchObject({ status: 200, truncated: false });
    expect(res.body.toString()).toBe("hello");
    expect(res.headers["x-k"]).toBe("v");
    expect(ua).toBe("MKMN");
    expect(lookups).toEqual(["pub.test"]);
  });

  it("reads an https address through https, with no allowHttp needed", async () => {
    httpsCalls.length = 0;
    handler = (_q, r) => r.end("secure");
    const res = await pinnedGet("https://pub.test/lib.js", opts({ allowHttp: false }));
    expect(res.body.toString()).toBe("secure");
    expect(httpsCalls).toEqual(["https://pub.test/lib.js"]);
  });

  it("returns a non-2xx answer as it is, body and all", async () => {
    handler = (_q, r) => { r.statusCode = 404; r.end("missing"); };
    const res = await pinnedGet("http://pub.test/x", opts());
    expect([res.status, res.body.toString()]).toEqual([404, "missing"]);
  });

  it("returns a 3xx without a Location as the answer, not a redirect", async () => {
    handler = (_q, r) => { r.statusCode = 304; r.end(); };
    const res = await pinnedGet("http://pub.test/x", opts());
    expect(res.status).toBe(304);
    expect(hits).toHaveLength(1);
  });
});

describe("pinnedGet follows redirects one checked hop at a time", () => {
  it("follows a relative and an absolute redirect, looking each host up at its own connection", async () => {
    handler = (q, r, n) => {
      if (n === 1) { r.statusCode = 302; r.setHeader("location", "/b.js"); return r.end("ignored"); }
      if (n === 2) { r.statusCode = 301; r.setHeader("location", "http://cdn.test/c.js"); return r.end(); }
      r.end(`final ${q.url}`);
    };
    const res = await pinnedGet("http://pub.test/a.js", opts());
    expect(res.body.toString()).toBe("final /c.js");
    expect(res.status).toBe(200);
    expect(hits).toEqual(["pub.test/a.js", "pub.test/b.js", "cdn.test/c.js"]);
    expect(lookups).toEqual(["pub.test", "pub.test", "cdn.test"]);
  });

  it("refuses a redirect to this PC or the local network, and never connects to it", async () => {
    for (const location of ["http://localhost/", "http://api.localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/"]) {
      hits = [];
      handler = (_q, r) => { r.statusCode = 302; r.setHeader("location", location); r.end(); };
      await expect(pinnedGet("http://pub.test/", opts()), location).rejects.toThrow(/Not read: the address is on this PC or the local network/);
      expect(hits, location).toEqual(["pub.test/"]);
    }
  });

  it("refuses a redirect to a name that resolves privately, at that hop's connection", async () => {
    handler = (_q, r) => { r.statusCode = 302; r.setHeader("location", "http://inside.test/"); r.end(); };
    const split = async (host: string) => [{ address: host === "inside.test" ? "192.168.1.1" : PUBLIC }];
    await expect(pinnedGet("http://pub.test/", opts({ lookup: split }))).rejects.toThrow(/^Not read: the address is on this PC or the local network\.$/);
    expect(hits).toEqual(["pub.test/"]);
  });

  it("refuses a redirect to an address with credentials or to another scheme", async () => {
    for (const [location, why] of [["https://u:p@pub.test/", /user name or password/], ["file:///C:/Windows/win.ini", /only https addresses are read \(file:\)/], ["ftp://pub.test/a.js", /only https/]] as const) {
      hits = [];
      handler = (_q, r) => { r.statusCode = 302; r.setHeader("location", location); r.end(); };
      await expect(pinnedGet("http://pub.test/", opts()), location).rejects.toThrow(why);
      expect(hits, location).toEqual(["pub.test/"]);
    }
  });

  it("stops after five redirects", async () => {
    handler = (_q, r, n) => { r.statusCode = 302; r.setHeader("location", `/hop${n}`); r.end(); };
    await expect(pinnedGet("http://pub.test/", opts())).rejects.toThrow("Not read: more than 5 redirects.");
    expect(hits).toHaveLength(6);
  });
});

describe("pinnedGet's limits and failures", () => {
  it("keeps at most maxBytes and says the body was cut", async () => {
    handler = (_q, r) => { r.write("a".repeat(600)); setTimeout(() => { r.write("b".repeat(600)); r.end("c".repeat(600)); }, 20); };
    const res = await pinnedGet("http://pub.test/big", opts({ maxBytes: 1000 }));
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(1000);
    expect(res.body.toString()).toBe("a".repeat(600) + "b".repeat(400));
  });

  it("returns a body of exactly maxBytes whole", async () => {
    handler = (_q, r) => r.end("x".repeat(1000));
    const res = await pinnedGet("http://pub.test/", opts({ maxBytes: 1000 }));
    expect([res.truncated, res.body.length]).toEqual([false, 1000]);
  });

  it("gives up on a server that does not answer", async () => {
    handler = () => undefined;
    await expect(pinnedGet("http://pub.test/slow", opts({ timeoutMs: 1500 }))).rejects.toThrow("no answer in 2 s");
  });

  it("fails when the connection breaks in the middle of the body", async () => {
    handler = (_q, r) => { r.setHeader("content-length", "1000"); r.write("partial"); setTimeout(() => r.socket?.destroy(), 20); };
    await expect(pinnedGet("http://pub.test/", opts())).rejects.toThrow(/aborted|socket hang up|ECONNRESET/);
  });

  it("fails, without connecting, when the name has no address", async () => {
    await expect(pinnedGet("http://nowhere.test/", opts({ lookup: async () => [] }))).rejects.toThrow("the address of nowhere.test could not be found");
    expect(hits).toEqual([]);
  });

  it("passes on a failed lookup, without connecting", async () => {
    await expect(pinnedGet("http://pub.test/", opts({ lookup: async () => { throw new Error("DNS server unreachable"); } }))).rejects.toThrow("DNS server unreachable");
    expect(hits).toEqual([]);
  });
});
