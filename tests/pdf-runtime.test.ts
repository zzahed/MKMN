// pdf.js calls Promise.try and Uint8Array.prototype.toHex; Node.js 24 lacks toHex, so the
// project requires Node.js 26. On an older runtime reading a PDF used to hang or fail deep
// inside pdf.js; now it stops at once with a message that names the fix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", async () => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const req = createRequire(process.cwd() + "/package.json");
  return { default: pathToFileURL(req.resolve("pdfjs-dist/build/pdf.worker.min.mjs")).href };
});

const { readPdf, pdfRuntimeMessage } = await import("../src/renderer/pdf");

const P = Promise as unknown as { try?: unknown };
const U = Uint8Array.prototype as unknown as { toHex?: unknown };
const realTry = P.try;
const realToHex = U.toHex;
afterEach(() => { P.try = realTry; U.toHex = realToHex; });

const tinyFile = () => new File([new TextEncoder().encode("%PDF-1.4\n%%EOF\n") as unknown as BlobPart], "t.pdf", { type: "application/pdf" });

describe("the PDF runtime", () => {
  it("fails fast with a clear message when Promise.try is missing", async () => {
    P.try = undefined;
    const started = Date.now();
    await expect(readPdf(tinyFile())).rejects.toThrow(/needs Node\.js 26 or later/);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it("fails fast with a clear message when Uint8Array toHex is missing (Node.js 24)", async () => {
    U.toHex = undefined;
    const started = Date.now();
    await expect(readPdf(tinyFile())).rejects.toThrow(/needs Node\.js 26 or later/);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  // The final review: readPdf runs in the app's window (WebView2), not in Node. There the old
  // message sent people to install Node.js, which the app ships itself; the fix is a newer WebView2.
  it("in the window, the message names WebView2, not Node.js", () => {
    const m = pdfRuntimeMessage("Promise.try", false);
    expect(m).toBe("PDF reading needs a newer Microsoft Edge WebView2 Runtime (Promise.try is missing). Update the WebView2 Runtime, then restart MKMN.");
    expect(m).not.toMatch(/Node/);
  });

  it("in Node, the message names Node.js 26", () => {
    expect(pdfRuntimeMessage("Uint8Array toHex", true)).toBe("PDF reading needs Node.js 26 or later (Uint8Array toHex is missing).");
  });

  it("package.json declares Node 26 or later", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).engines?.node).toBe(">=26");
  });

  it(".npmrc refuses installs on an older Node", () => {
    expect(readFileSync(".npmrc", "utf8")).toMatch(/^engine-strict=true$/m);
  });
});
