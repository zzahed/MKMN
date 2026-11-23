import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { modelFolders } from "../src/core/geniex";

// The fallback removal path feeds a recursive delete, so its candidate selection is a
// safety boundary: it must never widen a request into the cache root, a shared
// repository directory, or anything outside the models directory.
describe("modelFolders (the fallback removal path's candidate list)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mkmn-modelfolders-"));
  const models = path.join(root, "models");
  const outside = path.join(root, "outside");
  fs.mkdirSync(models, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(models, "org", "model"), { recursive: true });
  fs.mkdirSync(path.join(models, "models--org--model--q4_0"), { recursive: true });
  fs.mkdirSync(path.join(models, "plain"), { recursive: true });

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp best effort */ }
  });

  it("refuses empty, blank and precision-only names: the cache root is never selected", () => {
    expect(modelFolders("", models, () => true)).toEqual([]);
    expect(modelFolders("   ", models, () => true)).toEqual([]);
    expect(modelFolders(":", models, () => true)).toEqual([]);
    expect(modelFolders(":/x", models, () => true)).toEqual([]);
  });

  it("never returns the models directory itself", () => {
    const folders = modelFolders("plain", models, () => true);
    for (const f of folders) {
      const rel = path.relative(models, f);
      expect(rel).not.toBe("");
      expect(rel).not.toBe(".");
      expect(rel.startsWith("..")).toBe(false);
    }
  });

  it("drops candidates that lexically escape the models directory", () => {
    expect(modelFolders("../outside", models, () => true)).toEqual([]);
    expect(modelFolders("plain/../../outside", models, () => true)).toEqual([]);
  });

  it("returns the real folder of a precision-less model", () => {
    expect(modelFolders("org/model", models, (p) => p === path.join(models, "org", "model")))
      .toEqual([path.join(models, "org", "model")]);
  });

  it("a precision request never selects the SHARED repository directory", () => {
    // `org/model:q4_0` must not widen into `org/model`: other precisions of the same
    // model live there, and this call was only asked to remove one.
    const shared = path.join(models, "org", "model");
    const folders = modelFolders("org/model:q4_0", models, (p) => p === shared);
    expect(folders).toEqual([]); // only a precision-specific folder would qualify
  });

  it("a precision request selects the precision-specific folder when it exists", () => {
    const specific = path.join(models, "models--org--model--q4_0");
    expect(modelFolders("org/model:q4_0", models, (p) => p === specific)).toEqual([specific]);
  });

  it("drops a reparse point whose real target sits outside the models directory", () => {
    const link = path.join(models, "plain", "escape-junction");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      // junction creation can be restricted in some environments: the containment
      // contract is still covered by the lexical tests above
      return;
    }
    expect(modelFolders("plain/escape-junction", models, (p) => p === link)).toEqual([]);
    try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* temp best effort */ }
  });
});

// Canonical model names are lower case ("qualcomm/qwen3-1.7b"); the cache keeps the
// publisher's spelling ("qualcomm/Qwen3-1.7B"). Windows matches the two by default, but a
// case-sensitive folder (Linux, or a Windows folder with case sensitivity turned on) does not.
describe("modelFolders on a case-sensitive file system", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mkmn-modelcase-"));
  const models = path.join(root, "models");
  fs.mkdirSync(path.join(models, "qualcomm", "Qwen3-1.7B"), { recursive: true });
  fs.mkdirSync(path.join(root, "outside", "qualcomm", "Qwen3-1.7B"), { recursive: true });

  /** exists() as a case-sensitive file system answers it: every segment spelt exactly as on disk. */
  const exactExists = (p: string): boolean => {
    const rel = path.relative(models, p);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    let at = models;
    for (const seg of rel.split(path.sep).filter(Boolean)) {
      try { if (!fs.readdirSync(at).includes(seg)) return false; } catch { return false; }
      at = path.join(at, seg);
    }
    return true;
  };

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp best effort */ }
  });

  it("finds the folder whose name differs from the canonical name only in case", () => {
    expect(modelFolders("qualcomm/qwen3-1.7b", models, exactExists)).toEqual([path.join(models, "qualcomm", "Qwen3-1.7B")]);
  });

  it("still finds nothing for a model that is not there in any case", () => {
    expect(modelFolders("qualcomm/qwen3-4b", models, exactExists)).toEqual([]);
  });

  it("never matches its way out of the models folder", () => {
    expect(modelFolders("../Outside/qualcomm/qwen3-1.7b", models, exactExists)).toEqual([]);
    expect(modelFolders("../Outside/qualcomm/qwen3-1.7b", models)).toEqual([]);
  });
});
