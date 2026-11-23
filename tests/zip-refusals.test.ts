import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { crc32, readZip, writeZip } from "../src/core/zip";

/**
 * A zip the person opens (a docx, xlsx or pptx) comes from outside: each refusal below is
 * a hostile or damaged file that must be named as such, before it can take the app's memory
 * or be decoded as garbage. Each starts from a good zip and changes one field.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Where the end record and the first directory entry of a zip sit. */
function layout(z: Uint8Array) {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const end = z.length - 22;
  return { v, end, dir: v.getUint32(end + 16, true) };
}

/** A one-entry zip with a raw body and directory fields chosen by the test. */
function zipOf(name: string, body: Uint8Array, method: number, crc: number, usize: number): Uint8Array {
  const nm = enc(name);
  const head = new Uint8Array(30 + nm.length);
  const h = new DataView(head.buffer);
  h.setUint32(0, 0x04034b50, true); h.setUint16(8, method, true); h.setUint32(14, crc, true);
  h.setUint32(18, body.length, true); h.setUint32(22, usize, true); h.setUint16(26, nm.length, true);
  head.set(nm, 30);
  const cen = new Uint8Array(46 + nm.length);
  const c = new DataView(cen.buffer);
  c.setUint32(0, 0x02014b50, true); c.setUint16(10, method, true); c.setUint32(16, crc, true);
  c.setUint32(20, body.length, true); c.setUint32(24, usize, true); c.setUint16(28, nm.length, true); c.setUint32(42, 0, true);
  cen.set(nm, 46);
  const tail = new Uint8Array(22);
  const t = new DataView(tail.buffer);
  t.setUint32(0, 0x06054b50, true); t.setUint16(8, 1, true); t.setUint16(10, 1, true); t.setUint32(12, cen.length, true); t.setUint32(16, head.length + body.length, true);
  const out = new Uint8Array(head.length + body.length + cen.length + tail.length);
  out.set(head, 0); out.set(body, head.length); out.set(cen, head.length + body.length); out.set(tail, head.length + body.length + cen.length);
  return out;
}

describe("readZip finds the zip's end record", () => {
  it("refuses a file too short to be a zip, and one with no end record", async () => {
    await expect(readZip(new Uint8Array(0))).rejects.toThrow("This file is not a valid Office file (no zip structure).");
    await expect(readZip(enc("PK but not a zip at all, just some text"))).rejects.toThrow(/no zip structure/);
  });

  it("finds the end record behind a trailing comment", async () => {
    const z = await writeZip({ "a.txt": enc("hi") });
    const withComment = new Uint8Array(z.length + 10);
    withComment.set(z);
    new DataView(withComment.buffer).setUint16(z.length - 2, 10, true);
    withComment.set(enc("a comment!"), z.length);
    expect(dec((await readZip(withComment))["a.txt"])).toBe("hi");
  });
});

describe("readZip refuses a hostile directory", () => {
  it("refuses more than 2000 entries before reading any", async () => {
    const z = await writeZip({ "a.txt": enc("x") });
    const { v, end } = layout(z);
    v.setUint16(end + 10, 2001, true);
    await expect(readZip(z)).rejects.toThrow("This file holds 2001 entries: too many to read.");
  });

  it("refuses a directory that claims more entries than it holds", async () => {
    const z = await writeZip({ "a.txt": enc("x") });
    const { v, end } = layout(z);
    v.setUint16(end + 10, 2, true);
    await expect(readZip(z)).rejects.toThrow("The zip directory is damaged.");
  });

  it("refuses a directory placed past the end of the file", async () => {
    const z = await writeZip({ "a.txt": enc("x") });
    const { v, end } = layout(z);
    v.setUint32(end + 16, z.length, true);
    await expect(readZip(z)).rejects.toThrow("The zip directory is damaged.");
  });

  it("refuses an entry that declares more than 100 MB, before decoding it", async () => {
    const z = await writeZip({ "a.txt": enc("x") });
    const { v, dir } = layout(z);
    v.setUint32(dir + 24, 100 * 1024 ** 2 + 1, true);
    await expect(readZip(z)).rejects.toThrow("This file unpacks to more than the app can read.");
  });

  it("refuses an entry whose data runs past the end of the file", async () => {
    const z = await writeZip({ "a.txt": enc("x") });
    const { v, dir } = layout(z);
    v.setUint32(dir + 20, z.length, true);
    await expect(readZip(z)).rejects.toThrow("The zip directory is damaged.");
  });

  it("refuses a local header placed past the end of the file", async () => {
    const z = await writeZip({ "a.txt": enc("x") });
    const { v, dir } = layout(z);
    v.setUint32(dir + 42, z.length - 10, true);
    await expect(readZip(z)).rejects.toThrow("The zip directory is damaged.");
  });

  it("names an unsupported compression and the entry it is in", async () => {
    const z = zipOf("word/document.xml", enc("x"), 12, crc32(enc("x")), 1);
    await expect(readZip(z)).rejects.toThrow("Unsupported zip compression (12) in word/document.xml.");
  });
});

describe("readZip decodes against the real budget, not the declared size", () => {
  it("stops a deflate bomb that understates its size once it passes 100 MB", async () => {
    const body = deflateRawSync(new Uint8Array(100 * 1024 ** 2 + 64 * 1024));
    const z = zipOf("bomb.xml", body, 8, 0, 10);
    await expect(readZip(z)).rejects.toThrow("This file unpacks to more than the app can read.");
  }, 60_000);

  it("refuses a deflated entry whose bytes are not deflate data", async () => {
    const z = zipOf("a.xml", new Uint8Array([0xff, 0xff, 0xff, 0xff]), 8, 0, 4);
    await expect(readZip(z)).rejects.toThrow();
  });
});

describe("readZip and writeZip round trips", () => {
  it("skips folder entries and reads the files beside them", async () => {
    const z = await writeZip({ "word/": new Uint8Array(0), "word/document.xml": enc("<w/>") });
    expect(Object.keys(await readZip(z))).toEqual(["word/document.xml"]);
  });

  it("deflates text that shrinks and stores bytes that do not", async () => {
    const text = enc("<p>repeat</p>".repeat(50));
    const noise = new Uint8Array(200);
    let s = 7;
    for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) >>> 0; noise[i] = s >>> 24; }
    const z = await writeZip({ "a.xml": text, "b.bin": noise, "c.txt": enc("short") });
    const { v, dir } = layout(z);
    const methods: number[] = [];
    let p = dir;
    for (let i = 0; i < 3; i++) { methods.push(v.getUint16(p + 10, true)); p += 46 + v.getUint16(p + 28, true); }
    expect(methods).toEqual([8, 0, 0]);
    const back = await readZip(z);
    expect(back["a.xml"]).toEqual(text);
    expect(back["b.bin"]).toEqual(noise);
    expect(dec(back["c.txt"])).toBe("short");
  });

  it("knows the standard CRC-32 check value", () => {
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});
