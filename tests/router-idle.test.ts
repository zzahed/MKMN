import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ROUTER_GPU_AFTER, ROUTER_IDLE_MIN_MS, RouterIdleRelease, RouterPlacement, RouterWarmGate } from "../src/core/router";
import { RouterUsers } from "../src/core/routerUsers";

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

  it("does not stop a router another instance is using: it waits another window", () => {
    const release = vi.fn();
    let othersActive = true;
    const idle = new RouterIdleRelease(() => 300_000, release, () => othersActive);
    idle.begin(); idle.end();
    vi.advanceTimersByTime(300_000);
    expect(release).not.toHaveBeenCalled();
    othersActive = false;
    vi.advanceTimersByTime(300_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is wired in the sidecar: every use is counted, and the release resets the gate before it stops the server", () => {
    const main = readFileSync(new URL("../src/sidecar/main.ts", import.meta.url), "utf8");
    expect(main).toMatch(/new RouterIdleRelease\(/);
    const release = main.match(/function releaseIdleRouter\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(release).toMatch(/routerWarmGate\.reset\(\)[\s\S]*\.stop\(\)/);
    expect(main.match(/routerIdle\.begin\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    // the server's own keep-alive stays long: GenieX must never unload the model behind the gate's back
    expect(main).toMatch(/host: ROUTER_HOST[^\n]*keepaliveSec: 86_400/);
    // the owner asks the other instances before it stops, and an adopter records its uses
    expect(main).toMatch(/new RouterIdleRelease\([^\n]*routerUsers\.othersActive/);
    expect(main).toMatch(/routerUsers\.mark\(/);
    // every end of a use updates the shared record, or an adopter's busy count stays positive and
    // the owner keeps the router forever (the Codex review on #78: the router benchmark's cleanup)
    const ends = main.match(/routerIdle\.end\(\);[^\n]*/g) ?? [];
    expect(ends.length).toBeGreaterThanOrEqual(2);
    for (const end of ends) expect(end).toMatch(/noteRouterUse\(\)/);
  });
});

/**
 * A second MKMN instance adopts the first one's router. Its uses are recorded in a file of its
 * own, so the owner does not stop the shared server while the adopter is using it (the Codex
 * review on #78: the owner's local idleness stopped the server mid-question for the adopter).
 */
describe("the router's other users", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "mkmn-router-users-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const users = (pid: number, now: () => number, alive = (_: number) => true) => new RouterUsers(() => dir, { pid, now, alive });

  it("an adopter's recent or running use keeps the owner from stopping the server", () => {
    let t = 1_000_000;
    const owner = users(1, () => t), adopter = users(2, () => t);
    expect(owner.othersActive(300_000)).toBe(false);
    adopter.mark(1); // a long question starts
    t += 10 * 300_000;
    expect(owner.othersActive(300_000)).toBe(true); // still running, however long ago it began
    adopter.mark(0); // it ended
    t += 299_999;
    expect(owner.othersActive(300_000)).toBe(true);
    t += 1;
    expect(owner.othersActive(300_000)).toBe(false);
  });

  it("the owner's own file never counts", () => {
    const owner = users(1, () => 5);
    owner.mark(1);
    expect(owner.othersActive(300_000)).toBe(false);
  });

  it("a file left by an instance that is gone is removed and does not count", () => {
    const adopter = users(2, () => 5);
    adopter.mark(1);
    const owner = users(1, () => 5, (pid) => pid !== 2);
    expect(owner.othersActive(300_000)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an instance that stops adopting clears its file", () => {
    const adopter = users(2, () => 5);
    adopter.mark(1);
    adopter.clear();
    expect(readdirSync(dir)).toEqual([]);
    expect(users(1, () => 5).othersActive(300_000)).toBe(false);
  });
});
