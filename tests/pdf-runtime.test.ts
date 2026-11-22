// pdf.js calls Promise.try, which only Node.js 24 and later have. On an older runtime
// reading a PDF used to hang until the caller's timeout; now it stops at once with a
// message that names the fix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", async () => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const req = createRequire(process.cwd() + "/package.json");
  return { default: pathToFileURL(req.resolve("pdfjs-dist/build/pdf.worker.min.mjs")).href };
});

const { readPdf } = await import("../src/renderer/pdf");

const P = Promise as unknown as { try?: unknown };
const realTry = P.try;
afterEach(() => { P.try = realTry; });

const tinyFile = () => new File([new TextEncoder().encode("%PDF-1.4\n%%EOF\n") as unknown as BlobPart], "t.pdf", { type: "application/pdf" });

describe("the PDF runtime", () => {
  it("fails fast with a clear message when Promise.try is missing", async () => {
    P.try = undefined;
    const started = Date.now();
    await expect(readPdf(tinyFile())).rejects.toThrow(/needs Node\.js 24 or later/);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it("package.json declares Node 24 or later", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).engines?.node).toBe(">=24");
  });

  it(".npmrc refuses installs on an older Node", () => {
    expect(readFileSync(".npmrc", "utf8")).toMatch(/^engine-strict=true$/m);
  });
});
