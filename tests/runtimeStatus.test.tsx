// @vitest-environment jsdom
/**
 * Component tests for the poll-fed runtime status (App.tsx + MetersBar.tsx + the
 * observation model in metricsModel.ts), rendered against a stub bridge. They pin the
 * reliability contract of the status panel: a poll that fails must not leave "Ready"
 * or live-looking bars behind, an unchanged successful reading stays fresh, a changed
 * limit or note propagates even when the percentages stand still, an older response
 * never replaces a newer one, and a startup read that fails is said out loud with a
 * Retry that deletes nothing and stacks no duplicate listeners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/renderer/App";

beforeEach(() => {
  (window as any).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (window as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.innerWidth = 1024;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as any).mkmn;
});

// ------------------------------------------------------------------ fixtures

const TURN = { role: "user", content: "hello" };
const CONVS = [
  { id: "c1", title: "Standalone chat", updated: 10, turns: [TURN] },
];

const CATALOG = [{
  entry: { id: "m1", name: "Qwen3 1.7B", repo: "q/repo", quant: "W4A16", engine: "qairt", role: "chat", architecture: "Qwen3", sizeGB: 1.2, recommendedContext: 4096, sampling: { max_tokens: 2048 } },
  ref: "q/repo:W4A16", installed: true, hidden: false, custom: false,
  verdict: { estNpuGB: 1.2, contextTokens: 4096 },
}];

const SERVER = {
  state: "ready", endpoint: "http://127.0.0.1:18181/v1", nctx: 4096, compute: "npu",
  restarts: 0, lastError: null, pid: 42, model: "q/repo:W4A16",
  hardwareVerification: { verifiedNpu: true, cpuFallbackDetected: false, executionTarget: "npu" },
};

const METERS = {
  ramPercent: 50, ramUsedGB: 8, ramTotalGB: 16, ramWarning: false,
  npuMemGB: null, npuBudgetGB: 20, npuUtilPercent: 30, npuNote: null,
};

const SETTINGS = {
  selectedModelId: "m1", effort: "auto", subagents: true, developer: false, showKQuants: false,
  appearance: "dark", closeAction: "quit", closeNoticeOff: false,
  computeMode: "auto", compute: "npu", idleReleaseSec: 0, keepaliveSec: 0, startupTimeoutSec: 90,
  nctxMode: "auto", kvType: "auto", npuBudgetOverrideGB: null,
  braveKey: "", searchProvider: "brave", searxngUrl: "",
  voice: { sttModelId: null, ttsModelId: null, ttsSid: 0, sttCompute: "cpu", ttsCompute: "cpu", sttLanguage: "", autoSend: false, readAloud: false },
};

function makeApi(over: Record<string, any> = {}): any {
  const base: Record<string, any> = {
    appInfo: async () => ({ version: "0.0.1", arch: "arm64", platform: "win32", geniexPath: null, geniexVersion: null, geniexVersionWarning: null, problems: [] }),
    hardware: async () => ({ chipName: "Snapdragon X Elite", chipFamily: "x1", isSnapdragon: true, ramGB: 32, npuDetected: true, npuDriverVersion: "1.0", npuBudgetGB: 20, npuBudgetSource: "measured", cpuThreads: 12 }),
    settings: async () => ({ ...SETTINGS }),
    server: async () => ({ ...SERVER }),
    voiceStatus: async () => ({ worker: "off", stt: null, tts: null, sttProvider: null, ttsProvider: null, notice: null, ttsSampleRate: null, error: null }),
    projects: async () => [],
    artifacts: async () => [],
    tasks: async () => [],
    setupState: async () => ({ active: false }),
    conversations: async () => [],
    catalog: async () => CATALOG,
    meters: async () => ({ ...METERS }),
    hardwareConfig: async () => ({}),
    saveConversations: async () => undefined,
    saveSettings: async (p: any) => ({ ...SETTINGS, ...p }),
    saveVoice: async () => SETTINGS,
    selectModel: async () => undefined,
    saveProject: async () => undefined,
    deleteProject: async () => [],
    saveMedia: async () => ({ mediaId: "m1" }),
    readMedia: async () => null,
    dynamicInfo: async () => ({ data: {}, speeds: {}, profile: "16", autoProfile: "16", installedRefs: [], runsOn: {}, engines: {}, missing: {} }),
    voiceModels: async () => [],
    npuPlan: async () => null,
    serverLog: async () => [],
    powerStatus: async () => null,
    estimateMemory: async () => null,
    modelEvidence: async () => ({ manifest: [], records: [] }),
  };
  const merged = { ...base, ...over };
  return new Proxy(merged, {
    get: (t, p) => (p in t ? t[p as string] : (p as string).startsWith("on") ? () => () => {} : () => Promise.resolve(undefined)),
  });
}

/** Sets the bridge and seeds saved chats BEFORE App's useState initializer reads them. */
function boot(api: any, convs: any[] = []) {
  (window as any).mkmn = api;
  window.localStorage.setItem("opennpu.conversations", JSON.stringify(convs));
  return render(createElement(App));
}

/** Flushes the startup reads and the first poll round (all promise chains). */
const settleBoot = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};

/** Opens the AI status panel (sidebar footer). No async waits: the tests run on fake
    timers, so everything is flushed explicitly with settleBoot/act before this. */
const openPanel = () => {
  fireEvent.click(screen.getByRole("button", { name: /On-device AI/i }));
  return screen.getByRole("region", { name: "On-device AI status" });
};

// ------------------------------------------------------------------ polling

describe("poll freshness (status panel)", () => {
  it("failed polling reads as unavailable with a Retry, and Retry recovers the readings", async () => {
    vi.useFakeTimers();
    let fail = true;
    const api = makeApi({ meters: async () => { if (fail) throw new Error("bridge refused"); return { ...METERS }; } });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    expect(panel.textContent).toContain("Resource readings unavailable");
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
    // recovery: the SAME instance retries in place — the reading returns
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).toContain("8 / 16 GB");
    expect(panel.textContent).not.toContain("Resource readings unavailable");
  });

  it("a reading that stops refreshing goes stale past the 30 s contract: dimmed bars, stamp, Retry — never a live look", async () => {
    vi.useFakeTimers();
    let fail = false;
    let n = 0;
    const api = makeApi({ meters: async () => { n++; if (n > 1 || fail) throw new Error("bridge refused"); return { ...METERS }; } });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    expect(panel.textContent).toContain("8 / 16 GB");
    expect(panel.textContent).not.toContain("Readings stale");
    // the reading stops refreshing; 11 ticks (~33 s) age it past the 30 s window
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(33_000); });
    expect(panel.textContent).toContain("Readings stale");
    expect(panel.textContent).toContain("last updated");
    expect(panel.textContent).toContain("Retry");
    // the last values stay on screen but DIMMED — visibly not live
    expect(document.querySelectorAll(".meter-stale").length).toBe(3);
    // recovery renews the feed in place
    fail = false; n = 0;
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).not.toContain("Readings stale");
    expect(document.querySelectorAll(".meter-stale").length).toBe(0);
    expect(panel.textContent).toContain("8 / 16 GB");
  });

  it("unchanged successful readings stay fresh: an idle machine never ages into stale while polls succeed", async () => {
    vi.useFakeTimers();
    // the SAME rounded numbers every tick (an idle machine), but every poll succeeds
    const api = makeApi({ meters: async () => ({ ...METERS }) });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(panel.textContent).toContain("8 / 16 GB");
    expect(panel.textContent).not.toContain("Readings stale");
    expect(document.querySelectorAll(".meter-stale").length).toBe(0);
  });

  it("an older, slower response never replaces a newer observation", async () => {
    vi.useFakeTimers();
    let resolveFirst: (m: any) => void = () => {};
    let calls = 0;
    const api = makeApi({
      meters: () => {
        calls++;
        if (calls === 1) return new Promise((res) => { resolveFirst = res; }); // the hung older attempt
        return Promise.resolve({ ...METERS, ramUsedGB: 9 }); // the later attempt answers
      },
    });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    // the hung attempt bounds the feed: while it is in flight, interval ticks are
    // SKIPPED (no unbounded concurrency) and nothing live-looking is shown
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
    expect(calls).toBe(1);
    expect(panel.textContent).not.toContain("GB");
    // past the 10 s bound the caller stops waiting; the next tick reads the NEWER value
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(panel.textContent).toContain("9 / 16 GB");
    // the hung first attempt lands LATE with an older value: it must be dropped
    await act(async () => {
      resolveFirst({ ...METERS, ramUsedGB: 5 });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).toContain("9 / 16 GB");
    expect(panel.textContent).not.toContain("5 / 16 GB");
  });

  it("a changed memory limit and note propagate even when every percentage is unchanged", async () => {
    vi.useFakeTimers();
    let budget = 20;
    let note: string | null = null;
    const api = makeApi({ meters: async () => ({ ...METERS, npuBudgetGB: budget, npuNote: note }) });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    expect(panel.textContent).toContain("limit 20 GB");
    // same percentages, new limit and new explanation: the display must follow
    budget = 12;
    note = "Counters withheld: driver update pending";
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
    expect(panel.textContent).toContain("limit 12 GB");
    // the note describes the LOAD counters, so it belongs to the load bar's tooltip…
    const loadBar = [...panel.querySelectorAll<HTMLElement>(".meter")].find((el) => el.textContent!.includes("NPU load"))!;
    expect(loadBar.title).toContain("driver update pending");
    // …and never to the memory bar, whose provenance is its own (an estimate stands in here)
    const memBar = [...panel.querySelectorAll<HTMLElement>(".meter")].find((el) => el.textContent!.includes("NPU memory"))!;
    expect(memBar.title).not.toContain("driver update pending");
    expect(memBar.title).toContain("Model allocation — estimated");
  });

  it("the server status stops reading as Ready when its poll stops refreshing", async () => {
    vi.useFakeTimers();
    let fail = false;
    let n = 0;
    const api = makeApi({ server: async () => { n++; if (n > 1 || fail) throw new Error("status refused"); return { ...SERVER }; } });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    expect(panel.textContent).toContain("Ready on this device");
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(33_000); });
    // the fresh-looking state label is replaced by the honest one, with a stamp and Retry
    expect(panel.textContent).toContain("Status unavailable · last updated");
    expect(panel.textContent).not.toContain("Ready on this device");
    // recovery restores the live state
    fail = false; n = 0;
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).toContain("Ready on this device");
  });

  it("a hidden window is not polled; becoming visible reads immediately", async () => {
    vi.useFakeTimers();
    let hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    let reads = 0;
    const api = makeApi({ meters: async () => { reads++; return { ...METERS, ramUsedGB: reads }; } });
    boot(api, CONVS);
    await settleBoot();
    const atBoot = reads;
    hidden = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reads).toBe(atBoot); // nothing while hidden
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(reads).toBe(atBoot + 1); // visible again: an immediate read, not a full-interval wait
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
});

// ------------------------------------------------------------------ startup

describe("startup failure and recovery", () => {
  it("an essential read failing is said out loud with a Retry that preserves local chats and stacks no duplicate listeners", async () => {
    vi.useFakeTimers();
    let failSettings = true;
    let serverSubs = 0;
    const api = makeApi({
      settings: async () => { if (failSettings) throw new Error("settings read refused"); return { ...SETTINGS }; },
      onServer: () => { serverSubs++; return () => {}; },
    });
    boot(api, CONVS);
    await settleBoot();
    // the boot screen names the failed read and keeps the promise about local data
    expect(screen.getByRole("alert").textContent).toContain("Your settings failed");
    expect(screen.getByRole("alert").textContent).toContain("safe");
    expect(screen.getByRole("alert").textContent).not.toContain("Saved chats failed");
    // retry after the backend recovers: the app appears WITH the local chats
    failSettings = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(screen.getByText("Standalone chat")).toBeTruthy();
    // exactly one listener subscription was ever made (the retry added none)
    expect(serverSubs).toBe(1);
  });

  it("an optional read failing never blocks the app: a banner says what failed, with a working Retry", async () => {
    vi.useFakeTimers();
    let failProjects = true;
    const api = makeApi({ projects: async () => { if (failProjects) throw new Error("projects read refused"); return []; } });
    boot(api, CONVS);
    await settleBoot();
    // the app is up (the chat is there), and the banner names the optional failure
    expect(screen.getByText("Standalone chat")).toBeTruthy();
    const banner = screen.getByText(/Some data could not be loaded/).closest(".banner-row") as HTMLElement;
    expect(banner.textContent).toContain("Projects");
    expect(banner.textContent).toContain("Retry");
    // retry with the service recovered clears the banner (the Retry is per-section)
    failProjects = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry projects" }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(screen.queryByText(/Some data could not be loaded/)).toBeNull();
  });
});

// --------------------------------------------------- reliability hardening

describe("reliability hardening (feeds, watchdog, ordering, progressive startup)", () => {
  it("a hung request pair cannot keep fresh readings looking live: the watchdog expires them", async () => {
    vi.useFakeTimers();
    let mCalls = 0, sCalls = 0;
    const api = makeApi({
      meters: async () => { mCalls++; if (mCalls > 1) return new Promise<any>(() => {}); return { ...METERS }; },
      server: async () => { sCalls++; if (sCalls > 1) return new Promise<any>(() => {}); return { ...SERVER }; },
    });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    expect(panel.textContent).toContain("8 / 16 GB");
    expect(panel.textContent).toContain("Ready on this device");
    // from here on BOTH feeds' requests hang: no response will ever publish a phase.
    // The independent 1 s watchdog still expires the readings at the 30 s contract.
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(panel.textContent).toContain("Readings stale");
    expect(panel.textContent).toContain("Status unavailable · last updated");
    expect(document.querySelectorAll(".meter-stale").length).toBe(3);
  });

  it("the feeds are independent: a hung meters request cannot hold the server status back", async () => {
    vi.useFakeTimers();
    let mCalls = 0;
    let serverState = "ready";
    const api = makeApi({
      meters: async () => { mCalls++; if (mCalls > 1) return new Promise<any>(() => {}); return { ...METERS }; },
      server: async () => ({ ...SERVER, state: serverState }),
    });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    expect(panel.textContent).toContain("8 / 16 GB");
    // the meters request hangs; the server feed must still follow the lifecycle
    serverState = "stopped";
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
    expect(panel.textContent).toContain("Model idle");
    // and the meters reading expires on its own clock while the server stays live
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(panel.textContent).toContain("Readings stale");
    expect(panel.textContent).toContain("Model idle");
  });

  it("a newer server event wins over an in-flight poll: the late poll response is dropped", async () => {
    vi.useFakeTimers();
    let resolvePoll: (s: any) => void = () => {};
    let pollCalls = 0;
    let emitServer: ((s: any) => void) | null = null;
    const api = makeApi({
      server: () => {
        pollCalls++;
        if (pollCalls === 2) return new Promise((res) => { resolvePoll = res; }); // the in-flight poll
        return Promise.resolve({ ...SERVER });
      },
      onServer: (cb: (s: any) => void) => { emitServer = cb; return () => {}; },
    });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    expect(panel.textContent).toContain("Ready on this device");
    // a poll goes out and hangs
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(pollCalls).toBe(2);
    // a NEWER event lands while the poll is in flight
    await act(async () => {
      emitServer!({ ...SERVER, state: "stopped" });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).toContain("Model idle");
    // the old poll resolves late with the OLDER state: it must not replace the event
    await act(async () => {
      resolvePoll({ ...SERVER, state: "ready" });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).toContain("Model idle");
    expect(panel.textContent).not.toContain("Ready on this device");
    // and the feed must RECOVER: later polls still fire after the dropped response
    // (a leaked in-flight token would silently stop all server polling here)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
    expect(pollCalls).toBe(3);
    // the resumed poll reports the backend's current state and applies it normally
    expect(panel.textContent).toContain("Ready on this device");
  });

  it("a startup read that lands after a newer event cannot overwrite it", async () => {
    vi.useFakeTimers();
    let resolveBootRead: (s: any) => void = () => {};
    let serverCalls = 0;
    let emitServer: ((s: any) => void) | null = null;
    const api = makeApi({
      server: () => {
        serverCalls++;
        if (serverCalls === 1) return new Promise((res) => { resolveBootRead = res; }); // the startup read hangs
        return Promise.resolve({ ...SERVER });
      },
      onServer: (cb: (s: any) => void) => { emitServer = cb; return () => {}; },
    });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    // the startup server read is still hanging; a newer event arrives
    await act(async () => {
      emitServer!({ ...SERVER, state: "stopped" });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).toContain("Model idle");
    // the startup read lands LATE with the older state: the feed drops it
    await act(async () => {
      resolveBootRead({ ...SERVER, state: "ready" });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).toContain("Model idle");
    expect(panel.textContent).not.toContain("Ready on this device");
  });

  it("returning from a hidden window re-evaluates freshness immediately, then recovers", async () => {
    vi.useFakeTimers();
    let hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    let fail = false;
    const api = makeApi({ meters: async () => { if (fail) throw new Error("bridge refused"); return { ...METERS }; } });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    // hidden and not refreshed: the observation silently ages past the contract
    hidden = true; fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    hidden = false;
    // becoming visible re-publishes from the clock FIRST: the expiry shows at once
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(panel.textContent).toContain("Readings stale");
    expect(panel.textContent).toContain("last updated");
    // the immediate read follows (it fails here), then recovery renews the feed
    fail = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
    expect(panel.textContent).not.toContain("Readings stale");
    expect(panel.textContent).toContain("8 / 16 GB");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });

  it("an essential failure is said promptly while an optional read still hangs", async () => {
    vi.useFakeTimers();
    const api = makeApi({
      settings: async () => { throw new Error("settings read refused"); },
      projects: () => new Promise<any>(() => {}), // hangs forever, well past the essentials
    });
    boot(api, CONVS);
    await settleBoot();
    // the wall appears WITHOUT waiting on the hung optional read (no 10 s stall)
    expect(screen.getByRole("alert").textContent).toContain("Your settings failed");
    expect(screen.getByRole("alert").textContent).toContain("safe");
  });

  it("a pending optional section is named while it loads, and a superseded attempt cannot overwrite a newer verdict", async () => {
    vi.useFakeTimers();
    let call = 0;
    let resolveFirst: (v: any) => void = () => {};
    const api = makeApi({
      projects: () => {
        call++;
        if (call === 1) return new Promise((res) => { resolveFirst = res; }); // hangs, resolves late
        return Promise.reject(new Error("projects read refused"));
      },
    });
    boot(api, CONVS);
    await settleBoot();
    // the app is usable and names the pending section
    expect(screen.getByText("Standalone chat")).toBeTruthy();
    expect(screen.getByText(/Still loading/).textContent).toContain("Projects");
    // past the startup bound the hung attempt gives up: the failure is named, with its own Retry
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(screen.queryByText(/Still loading/)).toBeNull();
    expect(screen.getByText(/Some data could not be loaded/).textContent).toContain("Projects");
    // a per-key Retry goes out (the second attempt) and fails: the newer verdict is the failure
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry projects" }));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(screen.getByText(/Some data could not be loaded/)).toBeTruthy();
    // the OLD attempt (the hung first one) resolves late with SUCCESS: it must not
    // overwrite the newer failure verdict — the failed state stands
    await act(async () => {
      resolveFirst([]);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(screen.getByText(/Some data could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/Still loading/)).toBeNull();
  });

  it("a manual retry cannot stack unbounded concurrent requests", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const api = makeApi({ server: () => { calls++; return new Promise<any>(() => {}); } });
    boot(api, CONVS);
    await settleBoot();
    // boot itself makes exactly TWO bounded attempts — the mount poll and the forced
    // startup read — and both hang; at the 10 s bound each gives up and the status
    // reads as failed
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    const panel = openPanel();
    expect(panel.textContent).toContain("AI status unavailable");
    expect(calls).toBe(2);
    // a manual retry sends ONE new request…
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      await Promise.resolve();
    });
    expect(calls).toBe(3);
    // …but while THAT one is in flight, further retries are skipped, not stacked
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      await Promise.resolve();
    });
    expect(calls).toBe(3);
  });

  it("unmount stops the poll and watchdog intervals; a remount subscribes exactly once again", async () => {
    vi.useFakeTimers();
    let serverSubs = 0;
    let reads = 0;
    const api = makeApi({
      onServer: () => { serverSubs++; return () => {}; },
      meters: async () => { reads++; return { ...METERS }; },
    });
    const own = boot(api, CONVS);
    await settleBoot();
    expect(serverSubs).toBe(1);
    own.unmount();
    const readsAtUnmount = reads;
    // time passes after unmount: no poll may fire, nothing keeps running
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reads).toBe(readsAtUnmount);
    // and a remount makes exactly ONE new subscription (no leaked listeners)
    boot(api, CONVS);
    await settleBoot();
    expect(serverSubs).toBe(2);
  });
});

describe("measurement provenance (meters)", () => {
  it("a measured NPU memory reading says measured, and the note stays on the load bar", async () => {
    vi.useFakeTimers();
    const api = makeApi({
      meters: async () => ({ ...METERS, npuMemGB: 3.1, npuUtilPercent: 30, npuNote: "NPU utilization from the native monitor counters" }),
    });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    const memBar = [...panel.querySelectorAll<HTMLElement>(".meter")].find((el) => el.textContent!.includes("NPU memory"))!;
    expect(memBar.title).toBe("NPU memory — measured");
    expect(memBar.textContent).toContain("3.1 / 20 GB");
    expect(memBar.textContent).not.toContain("est.");
    expect(memBar.getAttribute("aria-label")).toContain("measured");
    // the note describes the LOAD counters: it belongs to the load bar alone
    const loadBar = [...panel.querySelectorAll<HTMLElement>(".meter")].find((el) => el.textContent!.includes("NPU load"))!;
    expect(loadBar.title).toContain("NPU utilization from the native monitor counters");
    expect(memBar.title).not.toContain("NPU utilization");
  });

  it("without a counter the memory bar is an explicitly marked estimate, or an honest n/a", async () => {
    vi.useFakeTimers();
    const api = makeApi({ meters: async () => ({ ...METERS, npuUtilPercent: null, npuNote: null }) });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    const memBar = [...panel.querySelectorAll<HTMLElement>(".meter")].find((el) => el.textContent!.includes("NPU memory"))!;
    expect(memBar.title).toContain("Model allocation — estimated");
    expect(memBar.textContent).toContain("~1.2 GB est.");
    expect(memBar.getAttribute("aria-label")).toContain("estimated");
    // the loaded model differs from the selected one: the estimate is withheld — n/a
    cleanup();
    const api2 = makeApi({ server: async () => ({ ...SERVER, model: "zzz/other:Q8" }), meters: async () => ({ ...METERS, npuUtilPercent: null, npuNote: null }) });
    boot(api2, CONVS);
    await settleBoot();
    const panel2 = openPanel();
    const mem2 = [...panel2.querySelectorAll<HTMLElement>(".meter")].find((el) => el.textContent!.includes("NPU memory"))!;
    expect(mem2.textContent).toContain("n/a");
    expect(mem2.title).toContain("NPU memory unavailable");
    expect(mem2.getAttribute("aria-label")).toContain("unavailable");
  });

  it("a stale feed dims the bars and stamps the age — an estimate never reads as a measurement then", async () => {
    vi.useFakeTimers();
    let fail = false;
    let n = 0;
    const api = makeApi({ meters: async () => { n++; if (n > 1 || fail) throw new Error("bridge refused"); return { ...METERS, npuUtilPercent: null, npuNote: null }; } });
    boot(api, CONVS);
    await settleBoot();
    const panel = openPanel();
    expect(memBarOf(panel).textContent).toContain("~1.2 GB est.");
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    const bar = memBarOf(panel);
    expect(bar.textContent).not.toContain("est.");
    expect(bar.textContent).toContain("n/a");
    expect(document.querySelectorAll(".meter-stale").length).toBe(3);
  });

  const memBarOf = (panel: HTMLElement) =>
    [...panel.querySelectorAll<HTMLElement>(".meter")].find((el) => el.textContent!.includes("NPU memory"))!;
});
