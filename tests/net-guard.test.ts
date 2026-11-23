import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { checkedLookup, isPrivateAddress, pinnedGet, type Lookup } from "../src/core/netGuard";

/**
 * An address from outside (a script library the person pastes, and its redirects)
 * may not reach this PC or the local network, at any hop.
 *
 * 2026-11-17 review: the name was resolved and checked BEFORE the request, and the
 * request then resolved it again on its own, so a name answering a public address
 * first and a private one second (DNS rebinding) passed. The check now runs inside
 * the connection's own lookup, connections are never pooled, and IPv6 forms that
 * carry a private IPv4 address (NAT64, 6to4, hex-written mapped) are private too.
 */

describe("isPrivateAddress", () => {
  it("knows loopback, private, link-local and unique-local ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "2001:4860:4860::8888"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("sees a private IPv4 address inside the IPv6 forms that carry one", () => {
    for (const ip of ["::ffff:7f00:1", "::ffff:a00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "2002:c0a8:0101::1", "2002:7f00:1::", "[::1]", "fe80::1%12", "ff02::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("64:ff9b::808:808")).toBe(false); // NAT64 of 8.8.8.8
    expect(isPrivateAddress("2002:808:808::1")).toBe(false); // 6to4 of 8.8.8.8
  });

  it("refuses what it cannot read as an address", () => {
    for (const ip of ["not-an-ip", "", "256.1.1.1", "1.2.3", "::g", "[]"]) expect(isPrivateAddress(ip), ip).toBe(true);
  });

  it("knows each reserved IPv4 range, and where it ends", () => {
    const priv = ["0.1.2.3", "10.255.255.255", "127.255.0.1", "169.254.0.1", "172.16.0.0", "172.31.255.255", "192.168.255.255",
      "192.0.0.8", "198.18.0.1", "198.19.255.255", "100.64.0.0", "100.127.255.255", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", " 10.0.0.1 "];
    for (const ip of priv) expect(isPrivateAddress(ip), ip).toBe(true);
    const pub = ["1.0.0.1", "9.255.255.255", "11.0.0.1", "126.255.255.255", "128.0.0.1", "169.253.0.1", "169.255.0.1", "172.15.255.255",
      "192.167.0.1", "192.169.0.1", "192.0.1.1", "192.1.0.1", "198.17.0.1", "198.20.0.1", "100.63.255.255", "100.128.0.0", "223.255.255.255"];
    for (const ip of pub) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("reads every way of writing an IPv6 address", () => {
    expect(isPrivateAddress("FE80::1")).toBe(true); // upper case
    expect(isPrivateAddress("fe80::")).toBe(true); // nothing after ::
    expect(isPrivateAddress("febf::1")).toBe(true); // the end of fe80::/10
    expect(isPrivateAddress("fec0::1")).toBe(false); // site-local (deprecated), past fe80::/10
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fe00::1")).toBe(false);
    expect(isPrivateAddress("0:0:0:0:0:0:0:1")).toBe(true); // written out, no ::
    expect(isPrivateAddress("2606:4700:0:0:0:0:0:1111")).toBe(false);
    expect(isPrivateAddress("2001:db8::1")).toBe(true); // documentation
    expect(isPrivateAddress("2001:db9::1")).toBe(false);
    expect(isPrivateAddress("2001:0:db8::1")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false); // mapped, public
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("::8.8.8.8")).toBe(false); // compatible, public
    expect(isPrivateAddress("::ffff:0:7f00:1")).toBe(false); // SIIT-translated form is not ::ffff:a.b.c.d
    expect(isPrivateAddress("64:ff9b::8.8.8.8")).toBe(false);
    expect(isPrivateAddress("64:ff9a::7f00:1")).toBe(false); // not the NAT64 prefix
    expect(isPrivateAddress("2002:0a00:0001::")).toBe(true); // 6to4 of 10.0.0.1
    expect(isPrivateAddress("[fe80::1%eth0]")).toBe(true);
  });
});

describe("checkedLookup: the connection's own lookup", () => {
  const call = (lookup: Lookup, all: boolean) => new Promise<{ err: any; a: any; f?: any }>((resolve) => {
    (checkedLookup(lookup) as any)("host.test", { all }, (err: any, a: any, f: any) => resolve({ err, a, f }));
  });

  it("hands the socket exactly the addresses it checked", async () => {
    const lookup: Lookup = async () => [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }];
    expect((await call(lookup, true)).a).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
    const one = await call(lookup, false);
    expect([one.a, one.f]).toEqual(["93.184.216.34", 4]);
  });

  it("refuses a name when ANY of its answers is private", async () => {
    const r = await call(async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }], true);
    expect(String(r.err?.message)).toMatch(/local network/);
  });

  it("answers through a callback given in place of the options", async () => {
    const r = await new Promise<any[]>((resolve) => (checkedLookup(async () => [{ address: "8.8.8.8" }]) as any)("host.test", (...a: any[]) => resolve(a)));
    expect(r).toEqual([null, "8.8.8.8", 4]);
  });

  it("works out the family of an answer that does not give one", async () => {
    expect((await call(async () => [{ address: "2606:4700::1111" }], true)).a).toEqual([{ address: "2606:4700::1111", family: 6 }]);
  });

  it("says a name with no answer was not found, with the code a socket expects", async () => {
    const r = await call(async () => [], false);
    expect(r.err).toMatchObject({ code: "ENOTFOUND", message: "the address of host.test could not be found" });
  });

  it("marks a private answer EPRIVATE, and passes a failed lookup on", async () => {
    expect((await call(async () => [{ address: "::1" }], false)).err).toMatchObject({ code: "EPRIVATE" });
    const boom = new Error("lookup failed");
    expect((await call(async () => { throw boom; }, true)).err).toBe(boom);
  });

  it("judges every connection on its own answer: a name that turns private is refused", async () => {
    let n = 0;
    const rebinding: Lookup = async () => (n++ === 0 ? [{ address: "93.184.216.34" }] : [{ address: "127.0.0.1" }]);
    expect((await call(rebinding, false)).err).toBeNull();
    expect(String((await call(rebinding, false)).err?.message)).toMatch(/local network/);
  });
});

describe("pinnedGet", () => {
  async function server(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
    let hits = 0;
    const s = http.createServer((_q, r) => { hits++; r.end("secret"); });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    return { port: (s.address() as AddressInfo).port, hits: () => hits, close: () => new Promise((ok) => s.close(() => ok())) };
  }

  it("never connects to a name that resolves to this PC (the rebinding target)", async () => {
    const srv = await server();
    try {
      const lookup: Lookup = async () => [{ address: "127.0.0.1", family: 4 }];
      await expect(pinnedGet(`http://rebind.test:${srv.port}/`, { lookup, maxBytes: 1000, timeoutMs: 3000, allowHttp: true })).rejects.toThrow(/local network/);
      expect(srv.hits()).toBe(0);
    } finally { await srv.close(); }
  });

  it("refuses plain http, credentials in the address, private literals and localhost before any lookup", async () => {
    let lookups = 0;
    const lookup: Lookup = async () => { lookups++; return [{ address: "93.184.216.34" }]; };
    const o = { lookup, maxBytes: 10, timeoutMs: 1000 };
    await expect(pinnedGet("http://public.test/a.js", o)).rejects.toThrow(/https/);
    await expect(pinnedGet("https://user:pw@public.test/a.js", o)).rejects.toThrow(/password/);
    await expect(pinnedGet("https://127.0.0.1:18181/v1/models", o)).rejects.toThrow(/local network/);
    await expect(pinnedGet("https://[::ffff:7f00:1]/", o)).rejects.toThrow(/local network/);
    await expect(pinnedGet("https://localhost/", o)).rejects.toThrow(/local network/);
    await expect(pinnedGet("file:///C:/Windows/win.ini", o)).rejects.toThrow(/https/);
    expect(lookups).toBe(0);
  });
});

describe("the sidecar reads outside addresses only through the pinned guard", () => {
  it("guards library downloads with the connection-time check and exposes no web search handler", () => {
    // the library download (fetchLibrary) lives with the model methods; the refusals below hold
    // for every file of the sidecar, main.ts and its area files alike
    expect(readFileSync("src/sidecar/register/models.ts", "utf8")).toContain("const r = await pinnedGet(");
    const dir = "src/sidecar";
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    expect(files).toContain("main.ts");
    const src = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(src).not.toContain("guardedFetch");
    expect(src).not.toMatch(/register\("(?:testWebSearch|wikimediaImage)"/);
    expect(src).not.toMatch(/redirect: "follow"/);
    const guard = readFileSync("src/core/netGuard.ts", "utf8");
    expect(guard).toMatch(/agent: false/);
    expect(guard).toMatch(/lookup: checkedLookup\(opts\.lookup\)/);
  });
});
