import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { NO_PROGRESS_SEC } from "../src/core/chat";
import { DEFAULT_NO_PROGRESS_SEC, Gateway } from "../src/core/harness/gateway";
import { FakeModel, DELTA, DONE, USAGE } from "../src/core/harness/testing";
import { posixRel } from "./helpers/platform";

/**
 * ONE stall watchdog for the whole app: one no-progress window, one health probe,
 * one recovery per call. The value is defined once (in the transport, chat.ts) and
 * the gateway — the only caller in the app — passes it on every call. These tests
 * fail if a second watchdog layer is ever wrapped around a call: the recovery
 * counts would multiply, and a second definition of the window would appear.
 */

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });

describe("one stall watchdog", () => {
  it("the window is defined exactly once, and the gateway's public constant is that value", () => {
    const src = path.join(process.cwd(), "src");
    const defining = walk(src).filter((f) => /NO_PROGRESS_SEC\s*=\s*\d/.test(readFileSync(f, "utf8")));
    expect(defining.map((f) => posixRel(path.relative(src, f)))).toEqual(["core/chat.ts"]);
    expect(NO_PROGRESS_SEC).toBe(45);
    expect(DEFAULT_NO_PROGRESS_SEC).toBe(NO_PROGRESS_SEC); // the gateway owns the policy, the value is the transport's
  });

  it("no app code sets its own literal stall window: every call inherits the one window", () => {
    const src = path.join(process.cwd(), "src");
    const offenders = walk(src)
      .filter((f) => !f.endsWith("chat.ts") && !f.endsWith("gateway.ts"))
      .map((f) => [f, readFileSync(f, "utf8")] as const)
      .filter(([, text]) => /noProgressSec\s*[:=]\s*[\d.]/.test(text));
    expect(offenders.map(([f]) => path.relative(src, f))).toEqual([]);
  });

  it("one hung call: the watchdog fires once, the recovery is exactly one, the ask happens twice, the partial words are taken back", async () => {
    const fake = new FakeModel(
      { chunks: [DELTA("Hel"), DELTA("lo")], hang: true }, // streams two words, then silence
      { chunks: [DELTA("Hello there!"), USAGE(12, 7), DONE] },
    );
    let up = false;
    const raw = fake.fetchFn;
    fake.fetchFn = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return up ? new Response("{}", { status: 200 }) : Promise.reject(new Error("fetch failed"));
      return raw(url, init);
    }) as typeof fetch;
    let recoveries = 0;
    const a = await new Gateway().ask({
      endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "hi" }],
      sampling: { temperature: 0, top_p: 1, max_tokens: 50 },
      fetchFn: fake.fetchFn, noProgressSec: 0.05,
      recover: async () => { recoveries++; up = true; return true; },
    });
    // A second watchdog wrapped around the same call would recover twice, or ask a third time.
    expect(recoveries).toBe(1);
    expect(fake.served).toBe(2);
    expect(a.text).toBe("Hello there!");
    expect(a.usage).toEqual({ prompt: 12, output: 7, measured: true });
  });
});
