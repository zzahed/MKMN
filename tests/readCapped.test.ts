import { afterAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readCapped } from "../src/core/folderRun";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-capped-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const big = (size: number) => new Error(`big ${size}`);

describe("readCapped", () => {
  it("reads a file through the handle it checked", () => {
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "hello");
    const r = readCapped(f, 100, big)!;
    expect(r.buf.toString("utf8")).toBe("hello");
    expect(r.st.isFile()).toBe(true);
  });

  it("refuses a file over the limit with the caller's error, and reads an empty one", () => {
    const f = path.join(dir, "b.txt");
    fs.writeFileSync(f, "x".repeat(11));
    expect(() => readCapped(f, 10, big)).toThrow("big 11");
    fs.writeFileSync(f, "");
    expect(readCapped(f, 10, big)!.buf.length).toBe(0);
  });

  it("gives null for a folder and throws for a path that does not exist", () => {
    expect(readCapped(dir, 10, big)).toBeNull();
    expect(() => readCapped(path.join(dir, "missing"), 10, big)).toThrow();
  });
});
