/**
 * The producer-to-consumer contract for per-artifact compiled context (Round 4, problem 1):
 * the sidecar's `compiledContexts` keys artifacts by the app's canonical identity
 * (`ai-hub-models/X` arrives as `qualcomm/X`), so every consumer must look the artifact up
 * canonically too. Before the fix the bridge looked up `m.repo.toLowerCase()` and silently
 * missed every ai-hub-models artifact — the pack fell back to the 4096 estimate even though
 * the installed bundle's real window (2048) had crossed the IPC.
 *
 * The last test is a LIVE sidecar smoke check: it starts the built sidecar
 * (dist/sidecar/main.js) and asks it over the real stdin/stdout protocol, asserting the
 * producer's keys are canonical. Skipped (explicitly) when the sidecar has not been built.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compiledContextOf } from "../src/core/qairt";
import { canonicalName } from "../src/core/modelIdentity";
import { dynamicItems } from "../src/renderer/tauriBridge";
import type { Settings } from "../src/shared/types";

// ---- a fake models cache holding ONE installed QAIRT artifact compiled to 2048
const CONFIG_2048 = JSON.stringify({ dialog: { context: { size: 2048 } }, models: {} });
function fakeCache(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-ctx-"));
  fs.mkdirSync(path.join(root, "qualcomm", "Qwen3-1.7B"), { recursive: true });
  fs.writeFileSync(path.join(root, "qualcomm", "Qwen3-1.7B", "genie_config.json"), CONFIG_2048);
  return root;
}

/** What the sidecar's `compiledContexts` dispatcher returns for this pack, byte for byte its keying. */
function sidecarProduced(repo: string, compiled: number | null): Record<string, number> {
  return compiled === null ? {} : { [canonicalName(repo)]: compiled };
}

describe("compiled context crosses the IPC by its canonical identity", () => {
  it("the producer keys the 2048 artifact canonically, and the consumer finds it there", () => {
    const root = fakeCache();
    try {
      const repo = "ai-hub-models/Qwen3-1.7B";
      // PRODUCER: the sidecar reads the bundle and key it canonically
      const compiled = compiledContextOf(repo, root);
      expect(compiled).toBe(2048);
      const produced = sidecarProduced(repo, compiled);
      expect(Object.keys(produced)).toEqual(["qualcomm/qwen3-1.7b"]); // NOT "ai-hub-models/qwen3-1.7b"
      // CONSUMER: the real bridge lookup, with the record exactly as it crossed the sidecar call.
      // The 2B pack is not in the 32 GB profile's lanes, so it is added the way the app does it:
      // by being the selected model.
      const settings = { selectedModelId: "dynamic:2B" } as Settings;
      const pack = dynamicItems(32, [], settings, produced).find((i) => i.ref === "dynamic:2B");
      expect(pack).toBeTruthy();
      // the limit reaches the catalog verdict — 2048, never the 4096 fallback
      expect(pack!.verdict.contextTokens).toBe(2048);
      expect(pack!.verdict.reasons.join(" ")).toContain("Context: 2048"); // measured, labeled as such
      expect(pack!.verdict.reasons.join(" ")).not.toMatch(/Context estimate/);
      // …the entry the meter and the request preparation read
      expect(pack!.entry.recommendedContext).toBe(2048);
      expect(pack!.entry.sampling.max_tokens).toBe(2048);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("the cache-spelling serve ref resolves the same 2048 (the serving path's fallback)", () => {
    const root = fakeCache();
    try {
      // the serving path asks by the ref the cache holds; both spellings are one artifact
      expect(compiledContextOf("qualcomm/Qwen3-1.7B", root)).toBe(2048);
      expect(compiledContextOf("ai-hub-models/Qwen3-1.7B", root)).toBe(2048);
      expect(compiledContextOf("unsloth/gemma-3-1b-it-GGUF", root)).toBeNull(); // a GGUF ref is not a QAIRT bundle
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a consumer that (still) looked up the raw repo spelling misses the artifact — the old bug, pinned", () => {
    const produced = sidecarProduced("ai-hub-models/Qwen3-1.7B", 2048);
    // the DEFECT's lookup: a plain lowercase of the repo, which the canonical keys never match
    expect(produced["ai-hub-models/qwen3-1.7b"]).toBeUndefined();
    // the fixed lookup finds it
    expect(produced[canonicalName("ai-hub-models/Qwen3-1.7B")]).toBe(2048);
  });
});

// ------------------------------------------------------------------ live sidecar smoke check

const SIDECAR = path.resolve(import.meta.dirname ?? ".", "../dist/sidecar/main.js");
const has = fs.existsSync(SIDECAR);
// CI builds the sidecar first and sets this, so a missing build fails there instead of skipping
if (process.env.MKMN_REQUIRE_SIDECAR === "1" && !has) throw new Error(`MKMN_REQUIRE_SIDECAR is set but ${SIDECAR} was not built`);

describe.skipIf(!has)("live sidecar IPC smoke check (the built sidecar, real stdin/stdout)", () => {
  it("answers compiledContexts with canonical, positive keys", async () => {
    const child = spawn(process.execPath, [SIDECAR], { stdio: ["pipe", "pipe", "pipe"] });
    const out: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => out.push(c));
    const reply = (id: string) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the sidecar did not answer "${id}" in time`)), 20000);
        const poll = setInterval(() => {
          const lines = out.join("").split(/\r?\n/);
          for (const l of lines) {
            if (!l.trim()) continue;
            try {
              const m = JSON.parse(l);
              if (m?.t === "res" && m.id === id) { clearInterval(poll); clearTimeout(timer); resolve(m); }
            } catch { /* a partial line: more output is coming */ }
          }
        }, 25);
      });
    try {
      child.stdin.write(`${JSON.stringify({ t: "req", id: "p", method: "ping", args: [] })}\n`);
      child.stdin.write(`${JSON.stringify({ t: "req", id: "c", method: "compiledContexts", args: [] })}\n`);
      child.stdin.end();
      const pong = await reply("p");
      expect(pong.ok).toBe(true); // the sidecar is alive and speaking the protocol
      const res = await reply("c");
      expect(res.ok).toBe(true);
      const map = res.result as Record<string, number>;
      expect(map).toBeTypeOf("object");
      for (const [k, v] of Object.entries(map)) {
        expect(k).not.toMatch(/ai-hub-models\//i); // canonical keys only, on the real wire
        expect(k).toBe(canonicalName(k));
        expect(v).toBeGreaterThan(0);
      }
    } finally {
      child.kill();
    }
  });
});
