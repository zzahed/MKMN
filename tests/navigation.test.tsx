// @vitest-environment jsdom
/**
 * Component interaction tests for the app shell: the navigation rail (tooltips,
 * expanded mode, active states), the sidebar (pinned shortcuts, project counts,
 * "Recent chats", empty states, collapsed folds), keyboard/focus behavior (chat
 * title buttons, Escape with focus return, drawer), runtime-status surfaces, and
 * the Models ↔ settings journey. These render the real `App` against a stub
 * bridge (`window.mkmn`) — no source-text assertions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/renderer/App";

// jsdom lacks these; the app degrades gracefully but the tests need them present.
beforeEach(() => {
  (window as any).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  Element.prototype.scrollIntoView = () => {};
  // jsdom does no layout: offsetParent is always null, which would hide every control
  // from the focus trap's visibility filter. Pretend everything is laid out.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (window as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  // a previous narrow-window test must not leave the next one in narrow mode
  window.innerWidth = 1024;
  window.localStorage.clear();
});

afterEach(() => { cleanup(); });

// ------------------------------------------------------------------ fixtures

const TURN = { role: "user", content: "hello" };

const PROJECT = { id: "p1", name: "Alpha project", description: "", instructions: "", files: [], created: 1, updated: 3 };

const CONVS = [
  { id: "c1", title: "Pinned project chat", updated: 30, projectId: "p1", pinned: true, turns: [TURN] },
  { id: "c2", title: "Second project chat", updated: 20, projectId: "p1", turns: [TURN] },
  { id: "c3", title: "Standalone chat", updated: 10, turns: [TURN] },
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

/** Windows NPU counters missing: the meter must fall back to the estimate ONLY
    when the loaded model is the selected one. */
const METERS_NO_COUNTERS = {
  ramPercent: 50, ramUsedGB: 8, ramTotalGB: 16, ramWarning: false,
  npuMemGB: null, npuBudgetGB: 20, npuUtilPercent: null, npuNote: null,
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
    projects: async () => [{ ...PROJECT }],
    artifacts: async () => [],
    tasks: async () => [],
    setupState: async () => ({ active: false }),
    conversations: async () => [],
    catalog: async () => CATALOG,
    meters: async () => null,
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
    // Diagnostics-tab tools (NpuLoadTest, BenchDashboard, EngineCompare, PromptLab)
    // poll these on mount; the Proxy's undefined would crash their renders.
    benchResults: async () => [],
    benchRoster: async () => ({ targets: [], tests: { express: 0, quick: 0, full: 0, launch: 0 }, costs: { express: [], quick: [], full: [], launch: [] } }),
    benchState: async () => ({ running: false, phase: "", currentTests: [], testCount: 0, series: [], results: [], lines: [], rows: [], modelCount: 0, log: [] }),
    npuTestRoster: async () => [],
    npuTestState: async () => ({ running: false, phase: "", currentTests: [], testCount: 0, series: [], results: [], lines: [], rows: [], modelCount: 0 }),
    npuResetStatus: async () => ({ ready: true }),
    engineCompareState: async () => ({ running: false, steps: [] }),
    foundryStatus: async () => ({ ready: false, installed: false, log: [] }),
    labState: async () => ({ running: false, phase: "", total: 0, done: 0, runs: [], models: [], log: [], failed: [] }),
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

/** Lets Chat's one-shot composer-focus (a requestAnimationFrame after mount) land
    before a test starts interacting, so it cannot steal focus mid-test. */
const settle = () => new Promise((r) => setTimeout(r, 40));

const railBtn = (name: string) => screen.getByRole("button", { name });

it.each([
  { name: "missing", settings: { selectedModelId: "m1" }, autoSend: true },
  { name: "null", settings: { ...SETTINGS, voice: null }, autoSend: true },
  { name: "partial", settings: { ...SETTINGS, voice: { autoSend: false } }, autoSend: false },
  { name: "malformed", settings: { ...SETTINGS, voice: { sttCompute: { toString: null } } }, autoSend: true },
])("opens saved chats and Voice settings when voice settings are $name", async ({ settings, autoSend }) => {
  boot(makeApi({ settings: async () => settings }), [CONVS[2]]);

  expect(await screen.findByRole("button", { name: "Standalone chat" })).toBeTruthy();
  expect(screen.getByText(TURN.content)).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();

  fireEvent.click(railBtn("Settings"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const categories = within(dialog).getByRole("navigation", { name: "Settings categories" });
  fireEvent.click(within(categories).getByRole("button", { name: /^Voice/ }));
  expect(await within(dialog).findByRole("heading", { name: "Dictation" })).toBeTruthy();
  const send = within(dialog).getByRole<HTMLInputElement>("checkbox", { name: /send voice messages as soon as i stop talking/i });
  expect(send.checked).toBe(autoSend);
});

it("shows the rejected model selection and retries that exact choice on request", async () => {
  const raw = "GenieX failed to load q/repo:W4A16\nSDKError(Model loading failed)\nContext error 1002";
  const error = { id: "model-load", title: raw.split("\n")[0], fix: "Choose another verified NPU model.", raw };
  const selections: string[] = [];
  boot(makeApi({
    server: async () => ({ ...SERVER, lastError: error }),
    selectModel: async (id: string) => {
      selections.push(id);
      if (selections.length === 1) throw raw;
    },
  }));
  fireEvent.click(await screen.findByTitle("Model and thinking"));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Qwen3 1.7B/i }));
  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toContain(error.title);
  expect(notice.textContent).toContain("Context error 1002");
  fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(selections).toEqual(["m1", "m1"]));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

// ------------------------------------------------------------------ rail

describe("navigation rail", () => {
  it("shows an immediate tooltip on hover and keyboard focus", async () => {
    boot(makeApi());
    const projects = await waitFor(() => railBtn("Projects"));
    fireEvent.mouseOver(projects);
    let tip = document.querySelector(".rail-tip");
    expect(tip?.textContent).toBe("Projects");
    fireEvent.mouseLeave(document.querySelector(".app-rail")!);
    expect(document.querySelector(".rail-tip")).toBeNull();
    fireEvent.focus(projects);
    tip = document.querySelector(".rail-tip");
    expect(tip?.textContent).toBe("Projects");
  });

  it("the Search tooltip shows the real shortcut, and the button opens Search", async () => {
    boot(makeApi());
    const search = await waitFor(() => railBtn("Search (Ctrl+K)"));
    fireEvent.focus(search);
    expect(document.querySelector(".rail-tip")?.textContent).toContain("Ctrl+K");
    fireEvent.click(search);
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeTruthy();
  });

  it("expanded rail with visible labels is remembered", async () => {
    boot(makeApi());
    const expand = await waitFor(() => railBtn("Show the rail labels"));
    fireEvent.click(expand);
    expect(document.querySelector(".app-rail")!.className).toContain("expanded");
    expect(screen.getByText("Tasks", { selector: ".rail-label" })).toBeTruthy();
    expect(window.localStorage.getItem("opennpu.railExpanded")).toBe("1");
  });

  it("marks the active destination programmatically", async () => {
    boot(makeApi());
    const projects = await waitFor(() => railBtn("Projects"));
    fireEvent.click(projects);
    await waitFor(() => expect(railBtn("Projects").getAttribute("aria-current")).toBe("page"));
  });
});

// ------------------------------------------------------------------ sidebar

describe("sidebar organization", () => {
  it("a pinned chat stays a shortcut: listed under Pinned AND inside its project, with the project count unchanged", async () => {
    boot(makeApi(), CONVS);
    await screen.findAllByText("Alpha project");
    // Pinned section holds the shortcut
    expect(screen.getByText("Pinned", { selector: ".recents-title" })).toBeTruthy();
    // the shortcut appears twice: in Pinned and in its project's list
    expect(screen.getAllByText("Pinned project chat").length).toBeGreaterThanOrEqual(2);
    // the project's count includes its pinned chat (2 chats in p1)
    const proj = screen.getAllByText("Alpha project").map((el) => el.closest(".proj-head")).find(Boolean)!;
    expect(proj.querySelector(".count")?.textContent).toBe("2");
  });

  it("labels the unpinned outside-project list honestly and gives an empty-state for projects", async () => {
    boot(makeApi({ projects: async () => [] }), [CONVS[2]]);
    expect(await screen.findByText("Recent chats", { selector: ".recents-title" })).toBeTruthy();
    expect(screen.getByText("Standalone chat")).toBeTruthy();
  });

  it("offers a create-project path when no projects exist", async () => {
    boot(makeApi({ projects: async () => [] }), []);
    await screen.findByText("Recent chats");
    const btn = screen.getByRole("button", { name: "create a project" });
    fireEvent.click(btn);
    await waitFor(() => expect(document.querySelector(".main .view")?.textContent).toContain("New project"));
  });

  it("collapsed sections keep no reachable controls (inert) and the title is a native button", async () => {
    boot(makeApi(), CONVS);
    const projectsHead = await screen.findByText("Projects", { selector: ".recents-title" });
    // collapse the Projects section
    fireEvent.click(projectsHead);
    const folds = [...document.querySelectorAll<HTMLElement>(".group .fold-inner")];
    const projectsFold = folds.find((f) => f.closest(".group")!.textContent!.includes("Alpha project"))!;
    expect(projectsFold.getAttribute("inert")).toBe("");
    // inside an open fold, each chat title is a real button — pinned and unpinned alike
    const titles = [...projectsFold.querySelectorAll<HTMLButtonElement>("button.recent-open")].map((b) => b.textContent);
    expect(titles).toContain("Second project chat");
    expect(titles).toContain("Pinned project chat");
  });

  it("opens a chat by activating its title button", async () => {
    boot(makeApi(), CONVS);
    const title = await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(title);
    await waitFor(() => expect(title.closest(".recent")!.className).toContain("active"));
  });
});

// ------------------------------------------------------------------ focus & status

describe("keyboard, focus and runtime status", () => {
  it("status panel: Escape closes and focus returns to the opener; the destination is named Developer settings", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    // Chat's boot composer focus is a rAF: under load it can land seconds later in
    // jsdom and would steal focus back after the Escape restore below. In the real
    // app it has long settled before anyone opens the status flyout.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
    const opener = await screen.findByRole("button", { name: /On-device AI/i });
    fireEvent.click(opener);
    const panel = await screen.findByRole("region", { name: "On-device AI status" });
    // selected vs loaded, requested vs observed
    expect(panel.textContent).toContain("Selected: Qwen3 1.7B");
    expect(panel.textContent).toContain("Loaded: Qwen3 1.7B");
    expect(panel.textContent).toContain("Requested device: NPU");
    expect(panel.textContent).toContain("Observed: Verified on the NPU");
    // the destination name matches the settings group, not "Diagnostics"
    expect(panel.textContent).toContain("Open Developer settings");
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await waitFor(() => expect(document.querySelector("#runtime-status")).toBeNull(), { timeout: 500 });
  });

  it("status stays reachable with the sidebar hidden (titlebar access point)", async () => {
    window.innerWidth = 800;
    boot(makeApi(), CONVS);
    await settle();
    // Chat's boot composer focus is a rAF (see the stacked-models test below): let it
    // land before opening the flyout, or it would steal focus back from Escape's return.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
    expect(document.querySelector(".sidebar")).toBeNull();
    const tb = await screen.findByRole("button", { name: /On-device AI: Ready/i });
    expect(tb.textContent).toContain("Ready");
    fireEvent.click(tb);
    const panel = await screen.findByRole("region", { name: "On-device AI status" });
    expect(panel.textContent).toContain("Loaded: Qwen3 1.7B");
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(tb));
    window.innerWidth = 1024;
  });

  it("narrow window: opening a chat folds the drawer so it never covers the conversation", async () => {
    window.innerWidth = 800;
    boot(makeApi(), CONVS);
    await settle();
    const toggle = await screen.findByRole("button", { name: "Show sidebar" });
    fireEvent.click(toggle);
    expect(document.querySelector(".sidebar")).toBeTruthy();
    const title = await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(title);
    await waitFor(() => expect(document.querySelector(".sidebar")).toBeNull());
    window.innerWidth = 1024;
  });
});

// ------------------------------------------------------------------ Models ↔ Performance journey

describe("Models and the settings journey", () => {
  /** A group button of the Settings navigation (the rail has its own Models button). */
  const setNav = () => document.querySelector('nav[aria-label="Settings categories"]') as HTMLElement;
  const group = (name: string) => within(setNav()).getByRole("button", { name: new RegExp(`^${name}`) });
  const railModels = () => document.querySelector<HTMLElement>('.rail-btn[aria-label="Local Models"]')!;

  it("Speed & memory leads with everyday choices; memory, conversation length and power start folded under Advanced", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Speed & memory"));
    await screen.findByRole("heading", { name: "Keep the model ready" });
    const adv = document.querySelector("details.set-adv") as HTMLDetailsElement;
    expect(adv.open).toBe(false);
    for (const id of ["sec-models-memory", "sec-models-context", "sec-models-power"]) {
      const sec = document.getElementById(id);
      if (sec) expect(adv.contains(sec), id).toBe(true); // power or plan may be absent; when present, folded
    }
    expect(adv.contains(document.getElementById("sec-models-retention"))).toBe(false);
    expect(adv.contains(document.getElementById("sec-models-compute"))).toBe(false);
  });

  it("the rail's Models button opens Settings on its Models group, the library inside it", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railModels());
    await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(group("Models").className).toContain("on"));
    expect(screen.getByText(/This library is the one place to install, remove and choose models/)).toBeTruthy();
    // one surface: no second dialog is stacked for the library
    expect(screen.queryByRole("dialog", { name: "Models" })).toBeNull();
    expect(railModels().className).toContain("active");
  });

  it("Speed & memory links to the Models group, and the group navigation is the way back", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Speed & memory"));
    fireEvent.click(await screen.findByRole("button", { name: "Models library" }));
    await waitFor(() => expect(group("Models").className).toContain("on"));
    expect(screen.getByText(/This library is the one place to install, remove and choose models/)).toBeTruthy();
    fireEvent.click(group("Speed & memory"));
    expect(await screen.findByRole("button", { name: "Models library" })).toBeTruthy();
    expect(group("Speed & memory").className).toContain("on");
  });

  it("clears an unsubmitted HUMAIN key when leaving the provider page", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("HUMAIN Fuse"));
    const keyInput = await screen.findByLabelText("HUMAIN Fuse inference API key") as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "draft-not-saved" } });
    fireEvent.click(group("HUMAIN Node"));
    expect(await screen.findByLabelText("HUMAIN Node inference API key")).toBeTruthy();
    expect(screen.queryByLabelText("HUMAIN Fuse inference API key")).toBeNull();
    fireEvent.click(group("HUMAIN Fuse"));
    expect((screen.getByLabelText("HUMAIN Fuse inference API key") as HTMLInputElement).value).toBe("");
  });

  it("Escape, the × button and a backdrop click each close Settings from the Models group, and focus returns to the rail", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    // Chat's boot composer focus is a rAF: let it land first, or it can land after the
    // dialog closed and look like a lost focus return (the "Use" test waits the same way).
    await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
    const opener = railModels();
    opener.focus();
    fireEvent.click(opener);
    const dlg = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    // reopen, close via ×
    fireEvent.click(railModels());
    fireEvent.click(await screen.findByRole("button", { name: "Close Settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    // reopen, close via backdrop click
    fireEvent.click(railModels());
    await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(document.querySelector(".modal-backdrop")!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  });

  it("Escape in a filled settings search clears the search and keeps Settings open; Enter opens the first result", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    const input = await screen.findByLabelText("Search settings") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "theme" } });
    expect(await screen.findByRole("list", { name: /Search results/ })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "humain connections" } });
    await screen.findByRole("list", { name: /Search results/ });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(group("Shared cloud tools").className).toContain("on"));
    expect(input.value).toBe("");
  });

  it("Reset this group names what it will reset, asks inline, and offers Undo", async () => {
    const saves: any[] = [];
    let current: any = { ...SETTINGS, effort: "medium" };
    boot(makeApi({
      settings: async () => ({ ...current }),
      saveSettings: async (p: any) => { saves.push(p); current = { ...current, ...p }; return { ...current }; },
    }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Chats & answers"));
    fireEvent.click(await screen.findByRole("button", { name: /^Reset this group/ }));
    const ask = await screen.findByRole("alertdialog", { name: "Reset this group" });
    expect(ask.textContent).toContain("Thinking");
    expect(saves.length).toBe(0);
    fireEvent.click(within(ask).getByRole("button", { name: /^Reset/ }));
    await waitFor(() => expect(saves.some((p) => p.effort === "auto")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(saves.some((p) => p.effort === "medium")).toBe(true));
  });

  it("Up and Down move through the groups and open them; the Changed list reads choices as words", async () => {
    boot(makeApi({ settings: async () => ({ ...SETTINGS, effort: "medium" }) }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Files & projects"));
    group("Files & projects").focus();
    fireEvent.keyDown(group("Files & projects"), { key: "ArrowDown" });
    await waitFor(() => expect(group("Models").className).toContain("on"));
    expect(document.activeElement).toBe(group("Models"));
    const content = document.querySelector(".set-body")!;
    content.scrollTop = 400;
    fireEvent.keyDown(group("Models"), { key: "End" });
    await waitFor(() => expect(group("About").className).toContain("on"));
    expect(screen.getByRole("heading", { name: "About MKMN AI" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Appearance" })).toBeNull();
    expect(content.scrollTop).toBe(0);
    // the Changed list: an enum value is a word, not the stored lowercase id
    fireEvent.click(screen.getByRole("switch"));
    const list = await screen.findByRole("region", { name: "Changed settings" });
    expect(list.textContent).toContain("Now Medium");
    expect(list.textContent).toContain("Default Auto");
  });

  it("the NPU load test and Library options show the same part-CPU value: one setting, one state", async () => {
    let current: any = { ...SETTINGS, developer: true, allowHybridLoad: false };
    boot(makeApi({
      settings: async () => ({ ...current }),
      saveSettings: async (p: any) => { current = { ...current, ...p }; return { ...current }; },
      npuTestRoster: async () => [{ id: "m1", name: "Qwen3 1.7B", sizeGB: 1.2 }],
    }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Developer"));
    const hybrid = await screen.findByLabelText(/Also try hybrid mode/) as HTMLInputElement;
    await waitFor(() => expect(hybrid.checked).toBe(false));
    fireEvent.click(hybrid);
    fireEvent.click(group("Models"));
    const lib = await screen.findByLabelText(/Allow part-CPU loading/) as HTMLInputElement;
    await waitFor(() => expect(lib.checked).toBe(true));
  });

  it("the automatic NPU reset is not offered as a working switch where nothing acts on it", async () => {
    boot(makeApi({ settings: async () => ({ ...SETTINGS, developer: true }) }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Developer"));
    const auto = await screen.findByLabelText(/Reset the NPU by itself/) as HTMLInputElement;
    expect(auto.disabled).toBe(true);
    expect(auto.closest("label")!.textContent).toMatch(/not active in this build/);
  });

  it("Reset the NPU is a recovery section of its own, there without the developer tools", async () => {
    boot(makeApi({ settings: async () => ({ ...SETTINGS, developer: false }) }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Developer"));
    const btn = await screen.findByRole("button", { name: "Reset the NPU" });
    expect(btn.closest("section")!.id).toBe("sec-sys-recovery");
  });

  it("setting one turn limit to Default keeps the other one", async () => {
    const saves: any[] = [];
    let current: any = { ...SETTINGS, turnBudget: { maxCalls: 60, maxOutputTokens: 50000 } };
    boot(makeApi({
      settings: async () => ({ ...current }),
      saveSettings: async (p: any) => { saves.push(p); current = { ...current, ...p }; return { ...current }; },
    }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Chats & answers"));
    const calls = await screen.findByLabelText(/Model calls per turn/) as HTMLSelectElement;
    fireEvent.change(calls, { target: { value: "" } });
    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves.at(-1).turnBudget?.maxOutputTokens).toBe(50000);
  });

  it("the gear reopens Settings on the last settings group, never on the library", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Files & projects"));
    fireEvent.click(group("Models"));
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    expect(group("Files & projects").className).toContain("on");
  });
});

// ------------------------------------------------------------------ project editor

describe("the Files panel follows an index build to its end", () => {
  it("keeps polling while the index stays \"indexing\", until it is ready", async () => {
    let polls = 0;
    const withFile = { ...PROJECT, files: [{ id: "f1", name: "notes.txt", content: "The annex opens at nine. ".repeat(400) }] }; // longer than the read-at-once limit, so the preparing status shows
    boot(makeApi({
      projects: async () => [{ ...withFile }],
      knowledgeStatus: async () => { polls++; return polls <= 3 ? { state: "indexing", progress: { done: 0, of: 1 } } : { state: "ready" }; },
      knowledgeBuild: async () => ({ state: "indexing" }),
    }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Projects"));
    await waitFor(() => expect(document.querySelector(".card.clickable")).toBeTruthy());
    fireEvent.click([...document.querySelectorAll(".card.clickable")].find((c) => c.textContent!.includes("Alpha project")) as HTMLElement);
    await waitFor(() => expect(screen.getByText(/Your files are ready/)).toBeTruthy(), { timeout: 9000 });
    expect(polls).toBeGreaterThanOrEqual(4);
  }, 12000);
});

describe("the Reference files card says only what is true in each state", () => {
  const openAlpha = async () => {
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Projects"));
    await waitFor(() => expect(document.querySelector(".card.clickable")).toBeTruthy());
    fireEvent.click([...document.querySelectorAll(".card.clickable")].find((c) => c.textContent!.includes("Alpha project")) as HTMLElement);
  };

  it("over the limit and failed: a plain message and Try again, and no file claims to be prepared", async () => {
    const big = { ...PROJECT, files: [{ id: "f1", name: "notes.txt", content: "The annex opens at nine. ".repeat(400) }] };
    boot(makeApi({
      projects: async () => [{ ...big }],
      knowledgeStatus: async () => ({ state: "failed", error: "index build: tokenizer error." }),
      knowledgeBuild: async () => ({ state: "failed" }),
    }), CONVS);
    await openAlpha();
    const status = await screen.findByText(/Your files could not be prepared/, {}, { timeout: 5000 });
    expect(status.textContent).not.toMatch(/token|index/i); // the raw error stays out of the sentence
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(/Too long to read all at once/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/being prepared/);
    expect(screen.queryByRole("progressbar")).toBeNull(); // no meter over the limit
  });

  it("too many files: names the cause and offers no Try again, which could not help", async () => {
    const big = { ...PROJECT, files: [{ id: "f1", name: "notes.txt", content: "The annex opens at nine. ".repeat(400) }] };
    boot(makeApi({
      projects: async () => [{ ...big }],
      knowledgeStatus: async () => ({ state: "failed", error: "This project holds 250 files; the search index takes at most 200." }),
      knowledgeBuild: async () => ({ state: "failed" }),
    }), CONVS);
    await openAlpha();
    await screen.findByText(/more than 200 files/, {}, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("under the limit: a meter, no preparing status and no Try again, even if preparing failed", async () => {
    const small = { ...PROJECT, files: [{ id: "f1", name: "notes.txt", content: "The annex opens at nine." }] };
    boot(makeApi({
      projects: async () => [{ ...small }],
      knowledgeStatus: async () => ({ state: "failed", error: "boom" }),
      knowledgeBuild: async () => ({ state: "failed" }),
    }), CONVS);
    await openAlpha();
    const meter = await screen.findByRole("progressbar");
    expect(Number(meter.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(1); // never "0%" with a file in it
    expect(screen.getByText(/of what the assistant can read at once/)).toBeTruthy();
    expect(screen.getByText(/reads all of it in every chat in this project/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(document.querySelector('.proj-side [role="status"]')?.textContent).toBe("");
  });
});

describe("deleting a chat can be undone", () => {
  it("a deleted chat comes back, in its place, with Undo", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    const row = screen.getByRole("button", { name: "Standalone chat" }).closest(".recent")?.parentElement ?? document.body;
    fireEvent.click(within(row as HTMLElement).getAllByRole("button", { name: "Chat actions" }).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete chat" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Standalone chat" })).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: "Standalone chat" })).toBeTruthy();
  });
});

describe("a project the storage refused is not shown as saved", () => {
  it("names the project, keeps the edit on screen, and Retry saves it", async () => {
    let fail = true;
    const tries: string[] = [];
    boot(makeApi({
      saveProject: async (p: any) => { tries.push(p.name); if (fail) throw new Error("local storage refused the write"); return [p]; },
    }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Projects"));
    await waitFor(() => expect(document.querySelector(".card.clickable")).toBeTruthy());
    fireEvent.click([...document.querySelectorAll(".card.clickable")].find((c) => c.textContent!.includes("Alpha project")) as HTMLElement);
    fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "Alpha renamed" } });
    const alert = await screen.findByText(/could not be saved/, {}, { timeout: 3000 });
    expect(alert.textContent).toMatch(/Alpha renamed/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry saving the project" }));
    await waitFor(() => expect(screen.queryByText(/could not be saved/)).toBeNull());
    expect(tries.filter((n) => n === "Alpha renamed").length).toBeGreaterThanOrEqual(2);
  });
});

describe("the project editor never brings a project back", () => {
  it("deleting a project just edited does not save it again", async () => {
    const calls: string[] = [];
    (window as any).confirm = () => true;
    boot(makeApi({
      saveProject: async (p: any) => { calls.push(`save:${p.name}`); },
      deleteProject: async () => { calls.push("delete"); return []; },
    }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Projects"));
    await waitFor(() => expect(document.querySelector(".card.clickable")).toBeTruthy());
    fireEvent.click([...document.querySelectorAll(".card.clickable")].find((c) => c.textContent!.includes("Alpha project")) as HTMLElement);
    const name = await screen.findByLabelText("Project name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Alpha renamed" } });
    await new Promise((r) => setTimeout(r, 600)); // the editor's own save lands
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(calls).toContain("delete"));
    await new Promise((r) => setTimeout(r, 600));
    const after = calls.slice(calls.indexOf("delete") + 1);
    expect(after.filter((c) => c.startsWith("save:"))).toEqual([]);
    expect(calls.slice(0, before).some((c) => c === "save:Alpha renamed")).toBe(true);
  });
});

// ------------------------------------------------------------------ status accuracy

describe("Models installs update the kept-mounted Settings (shared catalog)", () => {
  const M2 = {
    entry: { id: "m2", name: "Phi 4 mini", repo: "q/phi", quant: "Q4", engine: "gguf", role: "chat", architecture: "Phi4", sizeGB: 2.3, recommendedContext: 4096, sampling: { max_tokens: 2048 } },
    ref: "q/phi:Q4", installed: true, hidden: false, custom: false,
    verdict: { estNpuGB: 2.3, contextTokens: 4096 },
  };
  const setNav = () => document.querySelector('nav[aria-label="Settings categories"]') as HTMLElement;
  const group = (name: string) => within(setNav()).getByRole("button", { name: new RegExp(`^${name}`) });

  it("installing a model from the Models group refreshes the other groups' dropdowns immediately", async () => {
    let catalog: any[] = CATALOG;
    const installCbs: ((p: any) => void)[] = [];
    boot(makeApi({
      settings: async () => ({ ...SETTINGS, developer: true }),
      catalog: async () => catalog,
      onInstall: (cb: any) => { installCbs.push(cb); return () => {}; },
    }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    // the benchmark dropdown (Developer group, diagnostics) lacks the new model at first
    fireEvent.click(group("Developer"));
    const sel = await screen.findByLabelText("Model to benchmark") as HTMLSelectElement;
    expect([...sel.options].some((o) => o.textContent!.includes("Phi 4 mini"))).toBe(false);
    // into the Models group, a model installs there
    fireEvent.click(group("Models"));
    await screen.findByText(/This library is the one place to install, remove and choose models/);
    catalog = [...CATALOG, M2];
    await act(async () => { installCbs.forEach((cb) => cb({ ref: "q/phi:Q4", phase: "done" })); await Promise.resolve(); });
    // back to Developer in the SAME Settings: the dropdown reflects the new catalog at once
    fireEvent.click(group("Developer"));
    await waitFor(() => expect([...(screen.getByLabelText("Model to benchmark") as HTMLSelectElement).options].some((o) => o.textContent!.includes("Phi 4 mini"))).toBe(true));
  });

  it("removing the selected model is said clearly, with the summary falling back honestly", async () => {
    let catalog: any[] = CATALOG;
    const installCbs: ((p: any) => void)[] = [];
    boot(makeApi({
      settings: async () => ({ ...SETTINGS, developer: true }),
      catalog: async () => catalog,
      onInstall: (cb: any) => { installCbs.push(cb); return () => {}; },
    }), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await waitFor(() => expect(setNav()).toBeTruthy());
    fireEvent.click(group("Speed & memory"));
    expect((await screen.findAllByText("Qwen3 1.7B")).length).toBeGreaterThan(0);
    // the install/remove stream is subscribed while the Models group is shown,
    // so the removal happens there
    fireEvent.click(group("Models"));
    await screen.findByText(/This library is the one place to install, remove and choose models/);
    catalog = [{ ...CATALOG[0], installed: false }];
    await act(async () => { installCbs.forEach((cb) => cb({ ref: "q/repo:W4A16", phase: "done" })); await Promise.resolve(); });
    fireEvent.click(group("Speed & memory"));
    // back on Speed & memory: the removal is said clearly
    expect(await screen.findByText(/no longer installed/)).toBeTruthy();
    expect(screen.getByText("none (removed)")).toBeTruthy();
  });
});

// ------------------------------------------------------------------ status accuracy

describe("status and measurement accuracy", () => {
  const METERS = { ...METERS_NO_COUNTERS };

  async function openPanel(api: any) {
    boot(api, CONVS);
    await settle();
    fireEvent.click(await screen.findByRole("button", { name: /On-device AI/i }));
    return screen.findByRole("region", { name: "On-device AI status" });
  }

  it("names the requested device from the shared mapping (hybrid is CPU + NPU, never CPU)", async () => {
    const panel = await openPanel(makeApi({ server: async () => ({ ...SERVER, compute: "hybrid" }) }));
    expect((await panel).textContent).toContain("Requested device: CPU + NPU");
  });

  it("resolves the loaded model's ref into its readable name, keeping the precise ref in the tooltip", async () => {
    const panel = await openPanel(makeApi());
    const el = await panel;
    const loaded = [...el.querySelectorAll(".muted.small")].find((d) => d.textContent!.startsWith("Loaded:"))!;
    expect(loaded.textContent).toBe("Loaded: Qwen3 1.7B");
    expect(loaded.title).toBe("q/repo:W4A16");
  });

  it("withholds the size estimate when the loaded model is not the selected one, and says so", async () => {
    const panel = await openPanel(makeApi({ server: async () => ({ ...SERVER, model: "zzz/unknown:Q8" }), meters: async () => ({ ...METERS }) }));
    const el = await panel;
    expect(el.textContent).toContain("Loaded: zzz/unknown:Q8");
    expect(el.textContent).toContain("differs from the selected one");
    // no "~GB est." figure may stand in for the missing counter of a different model
    expect(el.textContent).not.toContain("GB est.");
  });

  it("keeps the size estimate when the loaded model IS the selected one", async () => {
    const panel = await openPanel(makeApi({ meters: async () => ({ ...METERS }) }));
    const el = await panel;
    expect(el.textContent).toContain("~1.2 GB est.");
    expect(el.textContent).not.toContain("differs from the selected one");
  });
});

// ------------------------------------------------------------------ overlay policy

describe("overlay policy: only the topmost surface owns the keyboard", () => {
  it("Ctrl+K inside Settings opens Search on top; Escape closes only Search and restores focus into the dialog", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    const modelsNav = await screen.findByRole("button", { name: /^Speed & memory/ });
    fireEvent.click(modelsNav);
    modelsNav.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const search = await screen.findByRole("dialog", { name: "Search" });
    // the dialog is still open underneath, hidden from the accessibility tree
    expect(document.querySelector('.modal[aria-label="Settings"]')).toBeTruthy();
    expect(document.querySelector(".modal-backdrop:not(.search-backdrop)")!.getAttribute("aria-hidden")).toBe("true");
    // focus cannot leave the search surface: Shift+Tab from the first control wraps to the last
    search.querySelector<HTMLInputElement>("input")!.focus();
    fireEvent.keyDown(search, { key: "Tab", shiftKey: true });
    const focusables = [...search.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex='-1'])")];
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    // the dialog survived, and focus returned to the control that had it
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(modelsNav));
  });

  it("Ctrl+K inside the Models group behaves the same", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(document.querySelector<HTMLElement>('.rail-btn[aria-label="Local Models"]')!);
    const input = await screen.findByPlaceholderText("Search every source, or paste any link, command or id");
    input.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const search = await screen.findByRole("dialog", { name: "Search" });
    expect(document.querySelector('.modal[aria-label="Settings"]')).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    await waitFor(() => expect(input.contains(document.activeElement) || document.activeElement === input).toBe(true));
  });

  it("choosing a search result while a dialog is open closes the dialog and navigates", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    fireEvent.click(railBtn("Settings"));
    await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Search" });
    const input = screen.getByPlaceholderText("Search chats, projects, files and tasks");
    fireEvent.change(input, { target: { value: "Second" } });
    const searchBox = screen.getByRole("dialog", { name: "Search" });
    const hit = await waitFor(() => {
      const rows = within(searchBox).getAllByText(/Second project chat/);
      const row = rows[0].closest(".search-row");
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    fireEvent.click(hit);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search" })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    // the navigation actually happened underneath: the app is back on the chat tab
    await waitFor(() => expect(screen.getByRole("button", { name: "Chats" }).getAttribute("aria-current")).toBe("page"));
  });

  it("Use in the Models group closes Settings in one commit, and focus returns to the rail, not body", async () => {
    boot(makeApi(), CONVS);
    await settle();
    await screen.findByRole("button", { name: "Standalone chat" });
    // Chat's boot composer focus is a rAF: under load it can land seconds later in
    // jsdom and would race the dialog-close fallback below.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("TEXTAREA"));
    const opener = document.querySelector<HTMLElement>('.rail-btn[aria-label="Local Models"]')!;
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Settings" });
    // Re-selecting the in-use model still routes through select(): it closes the
    // dialog and returns to the chat in one commit.
    fireEvent.click(await screen.findByRole("button", { name: "In use" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body), { timeout: 3000 });
    expect(document.activeElement?.closest(".app-rail")).toBeTruthy();
  });
});
