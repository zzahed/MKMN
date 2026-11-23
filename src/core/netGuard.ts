// A download from the public web that cannot reach this PC or the local network.
//
// An address typed or pasted by the person (a script library for a skill) and the
// redirects it leads to come from outside: a name (or a redirect) pointing at
// localhost, a private range or a link-local address (a router, the model server
// on 127.0.0.1, a cloud metadata address) must not be read. Each hop is checked,
// and the check happens INSIDE the connection's own name lookup: the address that
// was checked is the address connected to, so a name that answers a public address
// to a first lookup and a private one to a second (DNS rebinding) cannot slip
// between them. No connection is reused (no agent), and no proxy is used.

import * as http from "node:http";
import * as https from "node:https";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

export type Lookup = (host: string) => Promise<Array<{ address: string; family?: number }>>;

const MAX_HOPS = 5;

function ipv4Private(p: number[]): boolean {
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && p[2] === 0) // IETF protocol assignments
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 100 && b >= 64 && b <= 127) // shared address space (carrier NAT)
    || a >= 224; // multicast and reserved
}

function v4Parts(s: string): number[] | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(s)) return null;
  const p = s.split(".").map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
}

/** The 16 bytes of an IPv6 address (with an IPv4 tail if written so), or null. */
function v6Bytes(s: string): number[] | null {
  if (isIP(s) !== 6) return null;
  let head = s;
  let tail: number[] = [];
  const dot = s.lastIndexOf(":");
  const v4 = v4Parts(s.slice(dot + 1));
  if (v4) { head = s.slice(0, dot + 1) + "0:0"; tail = v4; }
  const [l, r = ""] = head.split("::");
  const left = l ? l.split(":") : [];
  const right = head.includes("::") ? (r ? r.split(":") : []) : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map((g) => parseInt(g || "0", 16));
  const bytes = groups.flatMap((g) => [g >> 8, g & 255]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

/** Loopback, private, link-local, unique-local, unspecified, multicast, or an IPv6
 *  form that carries one of the private IPv4 ranges (mapped, compatible, NAT64, 6to4). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const four = v4Parts(v);
  if (four) return ipv4Private(four);
  const b = v6Bytes(v);
  if (!b) return true; // not an address we can read: refused
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (zeros(15) && (b[15] === 0 || b[15] === 1)) return true; // :: and ::1
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return ipv4Private(b.slice(12)); // ::ffff:a.b.c.d
  if (zeros(12)) return ipv4Private(b.slice(12)); // ::a.b.c.d (compatible, deprecated)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return ipv4Private(b.slice(12)); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4Private(b.slice(2, 6)); // 2002::/16 6to4
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  return false;
}

const LOCAL = "the address is on this PC or the local network";

/** Why the URL is refused before any connection, or null. A host name is judged later, at connect time. */
function urlProblem(url: URL, allowHttp: boolean): string | null {
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return `only https addresses are read (${url.protocol})`;
  if (url.username || url.password) return "an address with a user name or password is not read";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return LOCAL;
  if (isIP(host) && isPrivateAddress(host)) return LOCAL;
  return null;
}

/** The lookup the connection itself uses: every address the name answers is checked, and only
 *  those checked addresses are handed to the socket. One private answer refuses the name. */
export function checkedLookup(lookup: Lookup): LookupFunction {
  type Done = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;
  return ((hostname: string, options: LookupOptions | Done, callback?: Done) => {
    const cb = (typeof options === "function" ? options : callback) as Done;
    const all = typeof options === "object" && options?.all === true;
    lookup(hostname).then((answers) => {
      if (!answers.length) return cb(Object.assign(new Error(`the address of ${hostname} could not be found`), { code: "ENOTFOUND" }));
      if (answers.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error(`Not read: ${LOCAL}.`), { code: "EPRIVATE" }));
      const list = answers.map((a) => ({ address: a.address, family: a.family ?? isIP(a.address) }));
      if (all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    }, (e: NodeJS.ErrnoException) => cb(e));
  }) as LookupFunction;
}

export type PinnedResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean };

export type PinnedOptions = {
  lookup: Lookup;
  maxBytes: number;
  timeoutMs: number;
  /** Tests only: a local plain-http server. The app reads https. */
  allowHttp?: boolean;
};

/** GET with redirects followed here, one hop at a time, each hop checked at its connection. */
export async function pinnedGet(input: string, opts: PinnedOptions): Promise<PinnedResponse> {
  let url = new URL(input);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const why = urlProblem(url, !!opts.allowHttp);
    if (why) throw new Error(`Not read: ${why}.`);
    const res = await oneGet(url, opts);
    const location = res.status >= 300 && res.status < 400 ? res.headers.location : undefined;
    if (!location) return res;
    url = new URL(location, url);
  }
  throw new Error(`Not read: more than ${MAX_HOPS} redirects.`);
}

function oneGet(url: URL, opts: PinnedOptions): Promise<PinnedResponse> {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: "GET",
      agent: false, // a fresh connection every time: a pooled socket was never checked for this name
      lookup: checkedLookup(opts.lookup),
      headers: { "User-Agent": "MKMN", Accept: "*/*" },
      timeout: opts.timeoutMs,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, headers: res.headers, body: Buffer.alloc(0), truncated: false }); }
      const parts: Buffer[] = [];
      let n = 0;
      let truncated = false;
      res.on("data", (b: Buffer) => {
        if (truncated) return;
        parts.push(b);
        n += b.length;
        if (n > opts.maxBytes) { truncated = true; req.destroy(); resolve({ status, headers: res.headers, body: Buffer.concat(parts).subarray(0, opts.maxBytes), truncated }); }
      });
      res.on("end", () => { if (!truncated) resolve({ status, headers: res.headers, body: Buffer.concat(parts), truncated: false }); });
      res.on("error", (e) => { if (!truncated) reject(e); });
    });
    req.on("timeout", () => req.destroy(new Error(`no answer in ${Math.round(opts.timeoutMs / 1000)} s`)));
    req.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "EPRIVATE" ? new Error(e.message) : e));
    req.end();
  });
}
