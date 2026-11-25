import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTER_GPU_AFTER, ROUTER_IDLE_MIN_MS, RouterIdleRelease, RouterPlacement, RouterWarmGate } from "../src/core/router";

/**
 * The router's server held its model (about 850 MB) for 24 hours after one request. It is now
 * stopped after the user's idle window. The warm gate must be reset with it: a gate that still
 * believed the model warm sent the next question into a cold load (about 3.5 s) against the 2 s
 * timeout, counted a miss, and after ROUTER_GPU_AFTER of them moved the router to the GPU.
 */
describe("the router's idle release", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("releases once the idle window has passed since the last use, and not before", () => {
    const release = vi.fn();
    const idle = new RouterIdleRelease(() => 300_000, release);
    idle.begin(); idle.end();
    vi.advanceTimersByTime(299_999);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a new use restarts the window", () => {
    const release = vi.fn();
    const idle = new RouterIdleRelease(() => 300_000, release);
    idle.begin(); idle.end();
    vi.advanceTimersByTime(200_000);
    idle.begin(); idle.end();
    vi.advanceTimersByTime(200_000);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("never releases while a question or a warm-up is running", () => {
    const release = vi.fn();
    const idle = new RouterIdleRelease(() => 300_000, release);
    idle.begin(); idle.end();
    vi.advanceTimersByTime(100_000);
    idle.begin(); // a long warm-up starts
    vi.advanceTimersByTime(10 * 300_000);
    expect(release).not.toHaveBeenCalled();
    idle.end();
    vi.advanceTimersByTime(300_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("0 (kept ready) never releases", () => {
    const release = vi.fn();
    const idle = new RouterIdleRelease(() => 0, release);
    idle.begin(); idle.end();
    vi.advanceTimersByTime(86_400_000);
    expect(release).not.toHaveBeenCalled();
  });

  it("a very short window is raised to the floor, so one request's questions never meet a stopped router", () => {
    const release = vi.fn();
    const idle = new RouterIdleRelease(() => 1_000, release);
    idle.begin(); idle.end();
    vi.advanceTimersByTime(ROUTER_IDLE_MIN_MS - 1);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("the first request after a release is gated, so it is never a miss and never moves the router to the GPU", () => {
    const gate = new RouterWarmGate();
    const placement = new RouterPlacement();
    gate.markWarmed();
    // the sidecar's release: the gate is reset before the server is stopped
    const idle = new RouterIdleRelease(() => 300_000, () => gate.reset());
    idle.begin(); idle.end();
    vi.advanceTimersByTime(300_000);
    expect(gate.open).toBe(false);
    // what routerAsk / routerSort do: a closed gate refuses the ask (and warms) before it can time out
    for (let i = 0; i < ROUTER_GPU_AFTER + 1; i++) {
      if (gate.open) placement.missed();
    }
    expect(placement.compute).toBe("cpu");
  });

  it("is wired in the sidecar: every use is counted, and the release resets the gate before it stops the server", () => {
    const main = readFileSync(new URL("../src/sidecar/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/new RouterIdleRelease\(/);
    const release = main.match(/function releaseIdleRouter\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(release).toMatch(/routerWarmGate\.reset\(\)[\s\S]*\.stop\(\)/);
    expect(main.match(/routerIdle\.begin\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    // the server's own keep-alive stays long: GenieX must never unload the model behind the gate's back
    expect(main).toMatch(/host: ROUTER_HOST[^\n]*keepaliveSec: 86_400/);
  });
});
