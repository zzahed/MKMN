import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostSettingsWriter } from "../src/core/settingsWriter";

/**
 * 2026-11-17 review: when the host failed to take a settings patch twice, the sidecar
 * merged it into settings.json and wrote the file itself — a second writer outside the
 * host's lock, silent, able to overwrite a host save made in between — and its writeJson
 * fell back to a direct, non-atomic write when a rename failed. Now the host is the ONE
 * writer: a patch it could not take stays pending, is retried in order, and is logged.
 */

function manualTimers() {
  const due: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  return {
    schedule: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; due.push(t); return { cancel: () => { t.live = false; } }; },
    fire: () => { const t = due.find((x) => x.live); if (!t) return false; t.live = false; t.fn(); return true; },
    waits: () => due.map((t) => t.ms),
  };
}

describe("the sidecar's settings writer", () => {
  it("hands every patch to the host, one at a time and in order", async () => {
    const sent: Record<string, unknown>[] = [];
    let release: (() => void) | null = null;
    const w = new HostSettingsWriter({ save: (p) => { sent.push(p); return new Promise<void>((r) => { release = r; }); } });
    w.submit({ a: 1 });
    w.submit({ b: 2 });
    w.submit({ a: 3 });
    expect(sent).toEqual([{ a: 1 }]); // the next waits for the first answer
    release!();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([{ a: 1 }, { b: 2, a: 3 }]);
    release!();
    await w.whenSettled();
    expect(w.state()).toBe("idle");
  });

  it("keeps a refused patch pending, retries it, and newer keys win over the failed ones", async () => {
    const timers = manualTimers();
    const logs: string[] = [];
    let fail = true;
    const sent: Record<string, unknown>[] = [];
    const w = new HostSettingsWriter({
      save: async (p) => { sent.push(p); if (fail) throw new Error("host gone"); return { ...p }; },
      log: (l) => logs.push(l),
      delays: [10, 20],
      schedule: timers.schedule,
    });
    w.submit({ theme: "dark", n: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.state()).toBe("pending");
    expect(logs[0]).toMatch(/not saved yet \(theme, n\).*host gone.*retry/);
    w.submit({ n: 2 }); // a newer value while the old one waits
    await new Promise((r) => setTimeout(r, 0));
    fail = false;
    timers.fire();
    await w.whenSettled();
    expect(sent.at(-1)).toEqual({ theme: "dark", n: 2 });
    expect(w.state()).toBe("idle");
    expect(logs.at(-1)).toMatch(/saved by the host after/);
  });

  it("gives up loudly after its last retry, and tries again on the next change", async () => {
    const timers = manualTimers();
    const logs: string[] = [];
    let calls = 0;
    const w = new HostSettingsWriter({ save: async () => { calls++; throw new Error("refused"); }, log: (l) => logs.push(l), delays: [5], schedule: timers.schedule });
    w.submit({ x: 1 });
    await new Promise((r) => setTimeout(r, 0));
    timers.fire();
    await w.whenSettled();
    expect(calls).toBe(2);
    expect(logs.at(-1)).toMatch(/NOT SAVED \(x\)/);
    expect(w.state()).toBe("pending");
    expect(timers.fire()).toBe(false); // nothing left scheduled
    w.submit({ y: 2 });
    await w.whenSettled();
    expect(calls).toBe(3);
  });

  it("what was submitted during a call stays visible on top of the host's answer", async () => {
    let release: ((v: unknown) => void) | null = null;
    let view: Record<string, unknown> = {};
    const w: HostSettingsWriter = new HostSettingsWriter({
      save: () => new Promise((r) => { release = r; }),
      onSaved: (merged) => { view = { ...(merged as object), ...w.unsaved() }; },
    });
    w.submit({ theme: "dark" });
    w.submit({ theme: "light" }); // newer, still waiting while the first call is out
    release!({ theme: "dark", other: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(view).toEqual({ theme: "light", other: 1 });
    release!({ theme: "light", other: 1 });
    await w.whenSettled();
    const src = readFileSync("src/sidecar/main.ts", "utf8");
    expect(src).toMatch(/value: \{ \.\.\.result, \.\.\.settingsWriter\.unsaved\(\) \}/);
  });

  it("the sidecar never writes settings.json itself and never falls back to a direct write", () => {
    const src = readFileSync("src/sidecar/main.ts", "utf8");
    expect(src).toMatch(/settingsWriter\.submit\(patch\)/);
    expect(src).not.toMatch(/writeJson\(settingsFile\(\)/);
    expect(src).not.toMatch(/fallbackSettingsWrite/);
    expect(src).not.toMatch(/fall back to a direct write/);
  });
});

describe("the settings writer's own defaults and reports", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("retries on its own timer after 2 s by default, and says one failed attempt in the singular", async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const saved: unknown[] = [];
    let calls = 0;
    const w = new HostSettingsWriter({
      save: async (p) => { calls++; if (calls === 1) throw new Error("host busy"); return { merged: p }; },
      onSaved: (m) => saved.push(m),
      log: (l) => log.push(l),
    });
    w.submit({ theme: "dark" });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.state()).toBe("pending");
    expect(log).toEqual(["[settings] not saved yet (theme): the host refused or did not answer (host busy); retry in 2 s"]);
    const settled = w.whenSettled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(calls).toBe(2);
    expect(saved).toEqual([{ merged: { theme: "dark" } }]);
    expect(log[1]).toBe("[settings] saved by the host after 1 failed attempt");
    expect(w.state()).toBe("idle");
  });

  it("reports a rejection that is not an Error by its value", async () => {
    const log: string[] = [];
    const w = new HostSettingsWriter({ save: () => Promise.reject("IPC closed"), log: (l) => log.push(l), delays: [] });
    w.submit({ a: 1 });
    await w.whenSettled();
    expect(log).toEqual(["[settings] NOT SAVED (a): the host refused 1 times (IPC closed); kept in memory until the next change is saved"]);
    expect(w.unsaved()).toEqual({ a: 1 });
  });

  it("says it is saving while the host has the patch, and settles only when the host answers", async () => {
    let release!: () => void;
    const w = new HostSettingsWriter({ save: () => new Promise<void>((r) => { release = r; }) });
    w.submit({ a: 1 });
    expect(w.state()).toBe("saving");
    expect(w.unsaved()).toEqual({}); // handed over: no longer only in memory
    let settled = false;
    const done = w.whenSettled().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    release();
    await done;
    expect(w.state()).toBe("idle");
  });

  it("does not settle while a retry is scheduled", async () => {
    const timers: Array<() => void> = [];
    let ok = false;
    const w = new HostSettingsWriter({
      save: async () => { if (!ok) throw new Error("no"); },
      delays: [10],
      schedule: (fn) => { timers.push(fn); return { cancel: () => undefined }; },
    });
    w.submit({ a: 1 });
    await new Promise((r) => setTimeout(r, 0));
    let settled = false;
    const done = w.whenSettled().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    ok = true;
    timers[0]();
    await done;
    expect(w.unsaved()).toEqual({});
  });
});

describe("a settings writer with nothing to save", () => {
  it("is idle and settled at once", async () => {
    const w = new HostSettingsWriter({ save: async () => { throw new Error("never called"); } });
    expect(w.state()).toBe("idle");
    await expect(w.whenSettled()).resolves.toBeUndefined();
  });
});
