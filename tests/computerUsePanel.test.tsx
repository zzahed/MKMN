// @vitest-environment jsdom
/**
 * Computer Use in the composer: the toggle beside the composer, the SAME
 * composer as the task field, the keyboard window picker, the run strip with
 * target and Stop, the verdict beside the task, and the fresh grant per run.
 * Contracts from docs/design/computer-use.md (the composer-flow section).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/renderer/App";
import type { AgentRunEvent, DriverWindow } from "../src/shared/agent";

const CATALOG = [{
  entry: { id: "m1", name: "Qwen3 8B", repo: "q/repo", quant: "Q4_0", engine: "geniex", role: "chat", architecture: "Qwen3", sizeGB: 4.9, recommendedContext: 4096, sampling: { max_tokens: 8192 } },
  ref: "q/repo:Q4_0", installed: true, hidden: false, custom: false,
  verdict: { estNpuGB: 4.9, contextTokens: 4096 },
}];
const SERVER = {
  state: "ready", endpoint: "http://127.0.0.1:18181/v1", nctx: 4096, compute: "npu",
  restarts: 0, lastError: null, pid: 42, model: "q/repo:Q4_0",
  hardwareVerification: { verifiedNpu: true, cpuFallbackDetected: false, executionTarget: "npu" },
};

const WINDOWS: DriverWindow[] = [
  { hwnd: 1, pid: 11, title: "*Meeting notes - October review - Notepad", process: "Notepad.exe", className: "Notepad" },
  { hwnd: 2, pid: 12, title: "*Meeting notes - October review - Notepad", process: "Notepad.exe", className: "Notepad" },
  { hwnd: 3, pid: 13, title: "Aramco_Docs - File Explorer", process: "explorer.exe", className: "CabinetWClass" },
];

function boot(agentApi: Record<string, unknown>) {
  const apiSettings = {
    selectedModelId: "m1", effort: "auto", subagents: false, developer: false, showKQuants: false,
    appearance: "dark", closeAction: "quit", closeNoticeOff: false,
    computeMode: "auto", compute: "npu", idleReleaseSec: 0, keepaliveSec: 0, startupTimeoutSec: 90,
    nctxMode: "auto", kvType: "auto", npuBudgetOverrideGB: null,
    voice: { sttModelId: null, ttsModelId: null, ttsSid: 0, sttCompute: "cpu", ttsCompute: "cpu", sttLanguage: "", autoSend: false, readAloud: false },
  };
  const api: Record<string, any> = {
    appInfo: async () => ({ version: "0.0.1", arch: "arm64", platform: "win32", geniexPath: null, geniexVersion: null, geniexVersionWarning: null, problems: [] }),
    hardware: async () => ({ chipName: "Snapdragon X Elite", chipFamily: "x1", isSnapdragon: true, ramGB: 32, npuDetected: true, npuDriverVersion: "1.0", npuBudgetGB: 20, npuBudgetSource: "measured", cpuThreads: 12 }),
    settings: async () => ({ ...apiSettings }),
    server: async () => ({ ...SERVER }),
    voiceStatus: async () => ({ worker: "off", stt: null, tts: null, sttProvider: null, ttsProvider: null, notice: null, ttsSampleRate: null, error: null }),
    projects: async () => [],
    artifacts: async () => [],
    tasks: async () => [],
    setupState: async () => ({ active: false }),
    conversations: async () => [],
    catalog: async () => CATALOG,
    meters: async () => null,
    saveConversations: async () => undefined,
    saveSettings: async (p: any) => ({ ...apiSettings, ...p }),
    selectModel: async () => undefined,
    dynamicInfo: async () => ({ data: {}, speeds: {}, profile: "16", autoProfile: "16", installedRefs: [], runsOn: {}, engines: {}, missing: {} }),
    modelEvidence: async () => ({ manifest: [], records: [] }),
    routerFileKind: async () => undefined,
    ...agentApi,
  };
  (window as any).mkmn = new Proxy(api, {
    get: (t, p) => (p in t ? t[p as string] : (p as string).startsWith("on") ? () => () => {} : () => Promise.resolve(undefined)),
  });
  window.localStorage.setItem("opennpu.conversations", JSON.stringify([
    { id: "c1", title: "Chat one", updated: 10, turns: [{ role: "assistant", content: "Hello there." }] },
  ]));
  render(createElement(App));
}

async function openChat(): Promise<HTMLTextAreaElement> {
  fireEvent.click(await screen.findByText("Chat one"));
  return (await waitFor(() => document.querySelector("textarea[aria-label='Message']"))) as HTMLTextAreaElement;
}

// The picker takes focus in an effect that runs AFTER the list is in the DOM:
// `findByRole` can return between the commit and that effect, so focus is only
// ever asserted with waitFor, never read synchronously.
async function openedPicker(): Promise<HTMLElement> {
  const listbox = await screen.findByRole("listbox", { name: "Windows" });
  await waitFor(() => expect(document.activeElement).toBe(listbox));
  return listbox;
}

const focusIsOnTask = () => waitFor(() => expect(document.activeElement).toBe(document.querySelector("textarea")));

function agentMocks() {
  const beginCalls: number[] = [];
  const runs: { id: string; hwnd: number; task: string; modelId: string }[] = [];
  const listeners: ((e: AgentRunEvent) => void)[] = [];
  const stopCalls: string[] = [];
  const docStarts: { id: string; sourcePath: string; task: string; modelId: string }[] = [];
  const decideCalls: { id: string; approved: boolean }[] = [];
  const openCalls: string[] = [];
  let docPickReply: string | null = "C:\\docs\\plan.docx";
  return {
    beginCalls, runs, listeners, stopCalls, docStarts, decideCalls, openCalls,
    setDocPickReply: (v: string | null) => { docPickReply = v; },
    api: {
      agentListWindows: async () => WINDOWS,
      agentBeginRun: async (hwnd: number) => {
        beginCalls.push(hwnd);
        const w = WINDOWS.find((x) => x.hwnd === hwnd)!;
        return { hwnd: w.hwnd, pid: w.pid, title: w.title, process: w.process };
      },
      agentStartRun: async (id: string, hwnd: number, task: string, modelId: string) => { runs.push({ id, hwnd, task, modelId }); },
      agentStopRun: async (id: string) => { stopCalls.push(id); },
      onAgentRun: (cb: (e: AgentRunEvent) => void) => { listeners.push(cb); return () => {}; },
      docPickSource: async () => docPickReply,
      docEditStart: async (id: string, sourcePath: string, task: string, modelId: string) => { docStarts.push({ id, sourcePath, task, modelId }); },
      docEditDecide: async (id: string, approved: boolean) => { decideCalls.push({ id, approved }); },
      openEditedCopy: async (p: string) => { openCalls.push(p); return true; },
    },
  };
}

function emit(listeners: ((e: AgentRunEvent) => void)[], ev: Partial<AgentRunEvent>) {
  act(() => {
    const full: AgentRunEvent = { runId: "agent-x", status: "running", step: 1, phase: "observe", line: "", actions: [], at: Date.now(), ...ev };
    listeners.forEach((l) => l(full));
  });
}

beforeEach(() => {
  (window as any).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  (window as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (window as any).IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Computer Use in the composer", () => {
  it("shows the Computer Use toggle beside the composer; agent mode reuses the SAME composer for the task", async () => {
    boot(agentMocks().api);
    const ta = await openChat();
    const chip = await screen.findByRole("button", { name: "Computer Use" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    await waitFor(() => expect(ta.getAttribute("aria-label")).toBe("The task for Computer Use"));
    // the run control is one short, stable label — the target row carries the name
    const run = screen.getByRole("button", { name: "Run task" });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    expect(run.getAttribute("title")).toContain("type the task first");
    expect(run.getAttribute("title")).toContain("choose a target");
    // the target row answers "what will the run work on" BEFORE any pick
    expect(document.querySelector(".agent-picked-row")!.textContent).toContain("Target:");
    expect(document.querySelector(".agent-picked-row")!.textContent).toContain("No window selected");
    expect(screen.getByRole("button", { name: "Choose window" })).toBeTruthy();
    // the draft typed in chat mode survives the switch
    fireEvent.change(ta, { target: { value: "the task" } });
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("the task");
  });

  it("lets the person type BEFORE choosing a window: Enter opens the picker and keeps the draft", async () => {
    boot(agentMocks().api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "Prepare a draft" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    // the keyboard contract: the opened picker HAS the focus, so Down/Enter/Escape
    // operate it without a Tab walk
    await openedPicker();
    await waitFor(() => expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Prepare a draft"));
  });

  it("the picker lists friendly app names, keeps the full title reachable, and distinguishes duplicate titles", async () => {
    boot(agentMocks().api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "task" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    const listbox = await screen.findByRole("listbox", { name: "Windows" });
    const options = listbox.querySelectorAll("[role='option']");
    expect(options).toHaveLength(3);
    // friendly app names, not raw process names
    expect(options[0].querySelector(".agent-window-sub")!.textContent).toBe("Notepad");
    expect(options[2].querySelector(".agent-window-sub")!.textContent).toBe("File Explorer");
    expect(options[0].textContent).toContain("*Meeting notes - October review - Notepad");
    expect(options[1].textContent).toContain("· window 2 of 2");
    // the full title is reachable by MOUSE (tooltip) and by KEYBOARD (the detail line follows the highlight)
    expect(options[0].getAttribute("title")).toBe("*Meeting notes - October review - Notepad · window 1 of 2");
    expect(options[0].getAttribute("aria-label")).toBe("Notepad — *Meeting notes - October review - Notepad · window 1 of 2");
    const detail = document.querySelector(".agent-picklist-detail")!;
    expect(detail.textContent).toContain("*Meeting notes - October review - Notepad");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    await waitFor(() => expect(document.querySelector(".agent-picklist-detail")!.textContent).toContain("window 2 of 2"));
    // Refresh re-lists
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listbox.querySelectorAll("[role='option']")).toHaveLength(3));
  });

  it("the picker answers the keyboard: Down and Enter pick, Escape closes, and focus returns to the task", async () => {
    boot(agentMocks().api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "task" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    // keys go to the picker only once it holds the focus, as they would for a person
    let listbox = await openedPicker();
    fireEvent.keyDown(listbox, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Windows" })).toBeNull());
    // Escape returns the keyboard to the task draft
    await focusIsOnTask();
    // reopen (the draft is kept), then pick by keyboard
    fireEvent.keyDown(ta, { key: "Enter" });
    listbox = await openedPicker();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Windows" })).toBeNull());
    // focus returns after the pick, too; the run control's tooltip carries the FULL title
    await focusIsOnTask();
    const run = await screen.findByRole("button", { name: "Run task" });
    expect(run.getAttribute("title")).toContain('*Meeting notes - October review - Notepad');
    // the target row names the app and the window
    expect(document.querySelector(".agent-picked-row")!.textContent).toContain("Target:");
    expect(document.querySelector(".agent-picked-row")!.textContent).toContain("Notepad:");
  });

  it("runs with a fresh grant every time; the target and Stop stay visible; the verdict comes back beside the task", async () => {
    const m = agentMocks();
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "Add a line" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    const listbox = await screen.findByRole("listbox", { name: "Windows" });
    fireEvent.click(listbox.querySelectorAll("[role='option']")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));

    await waitFor(() => expect(m.beginCalls).toEqual([1])); // a fresh grant, asked once per run
    await waitFor(() => expect(m.runs).toHaveLength(1));
    expect(m.runs[0].task).toBe("Add a line");
    // while the run goes, the strip keeps target and Stop visible
    emit(m.listeners, { runId: m.runs[0].id, line: "Reading the window (step 1)" });
    await screen.findByText(/Running in "\*Meeting notes - October review - Notepad"/);
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    // the verdict arrives: back to the composer, task kept, outcome beside it
    emit(m.listeners, { runId: m.runs[0].id, status: "done", phase: "settled", line: "Done: The line was added." });
    await waitFor(() => expect(document.querySelector(".agent-outcome")!.textContent).toBe("Done: The line was added."));
    const ta2 = (await waitFor(() => document.querySelector("textarea"))) as HTMLTextAreaElement;
    expect(ta2.value).toBe("Add a line");

    // a second run asks for a FRESH grant (begin again), never reuses the old one
    fireEvent.keyDown(ta2, { key: "Enter" });
    await waitFor(() => expect(m.beginCalls).toEqual([1, 1]));
  });

  it("a refused start keeps the draft and shows the error beside it", async () => {
    const m = agentMocks();
    m.api.agentBeginRun = async () => { throw new Error("another run is active"); };
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "the draft that must survive" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    const listbox = await screen.findByRole("listbox", { name: "Windows" });
    fireEvent.click(listbox.querySelectorAll("[role='option']")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    const err = await screen.findByRole("alert");
    expect(err.textContent).toContain("another run is active");
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("the draft that must survive");
  });

  it("releases the window's grant when the run fails to start after the grant was given", async () => {
    // The grant stayed held after a failed start, and every later run was refused
    // ("A Computer Use run is already active") with nothing to stop.
    const m = agentMocks();
    m.api.agentStartRun = async () => { throw new Error("the sidecar did not answer"); };
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "do the thing" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    const listbox = await screen.findByRole("listbox", { name: "Windows" });
    fireEvent.click(listbox.querySelectorAll("[role='option']")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(m.stopCalls.length).toBe(1));
  });

  it("offers to stop a run the window lost track of, instead of only refusing", async () => {
    const m = agentMocks();
    m.api.agentBeginRun = async () => { throw new Error("A Computer Use run is already active. Stop it first."); };
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "do the thing" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    const listbox = await screen.findByRole("listbox", { name: "Windows" });
    fireEvent.click(listbox.querySelectorAll("[role='option']")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop the active run" }));
    await waitFor(() => expect(m.stopCalls).toEqual([""])); // "" stops every run and releases the grant
  });

  it("a failed Stop is surfaced, never swallowed", async () => {
    const m = agentMocks();
    m.api.agentStopRun = async () => { throw new Error("the sidecar did not answer"); };
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "task" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    const listbox = await screen.findByRole("listbox", { name: "Windows" });
    fireEvent.click(listbox.querySelectorAll("[role='option']")[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    await waitFor(() => expect(m.runs).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Stop failed: the sidecar did not answer"));
  });

  it("shows a visible Change window control beside the picked target; switching keeps the draft and the next run grants the NEW window", async () => {
    const m = agentMocks();
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "the draft that follows the switch" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    const listbox = await screen.findByRole("listbox", { name: "Windows" });
    fireEvent.click(listbox.querySelectorAll("[role='option']")[0]); // hwnd 1
    // the picked target is visible while idle, with a Change window control beside it
    const row = document.querySelector(".agent-picked-row")!;
    await waitFor(() => expect(row.textContent).toContain("Target:"));
    expect(row.textContent).toContain("Meeting notes - October review");
    expect(row.textContent).toContain("Notepad:");
    const change = screen.getByRole("button", { name: "Change window" });
    expect(change.getAttribute("title")).toContain("the task draft is kept");
    // switching windows: the picker reopens, the draft survives, pick the OTHER window
    fireEvent.click(change);
    const listbox2 = await screen.findByRole("listbox", { name: "Windows" });
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("the draft that follows the switch");
    fireEvent.click(listbox2.querySelectorAll("[role='option']")[2]); // hwnd 3, explorer
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Windows" })).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    // a fresh grant for the NEW window, and the task is the untouched draft
    await waitFor(() => expect(m.beginCalls).toEqual([3]));
    await waitFor(() => expect(m.runs).toHaveLength(1));
    expect(m.runs[0].hwnd).toBe(3);
    expect(m.runs[0].task).toBe("the draft that follows the switch");
  });

  it("Edit a Word copy: the picker offers it, the doc row shows the file, and the run starts with NO grant", async () => {
    const m = agentMocks();
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: 'Change "shared drive" to "Q3 archive"' } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await screen.findByRole("listbox", { name: "Windows" });
    // the picker header offers the document road beside the window list
    fireEvent.click(within(document.querySelector(".agent-picklist-head")!).getByRole("button", { name: "Edit a Word copy" }));
    // the native dialog answered with a saved file: the doc row replaces the window row
    const row = await screen.findByText(/an edited copy is saved beside the original/);
    expect(row.textContent).toContain("plan.docx");
    expect(document.querySelector(".agent-picked-row")!.textContent).toContain("Target:");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Windows" })).toBeNull());
    // the run control is Run task for either target; the run starts with NO window grant
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    await waitFor(() => expect(m.docStarts).toHaveLength(1));
    expect(m.docStarts[0].sourcePath).toBe("C:\\docs\\plan.docx");
    expect(m.docStarts[0].task).toBe('Change "shared drive" to "Q3 archive"');
    expect(m.beginCalls).toEqual([]); // the file needs no grant and gets none
    // the run strip keeps the file and Stop visible while the loop works
    emit(m.listeners, { runId: m.docStarts[0].id, line: "Reading plan.docx." });
    await waitFor(() => expect(document.querySelector(".agent-target")!.textContent).toContain('Editing a copy of "plan.docx"'));
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    // the verdict comes back beside the task like any run's
    emit(m.listeners, { runId: m.docStarts[0].id, status: "done", phase: "settled", line: 'Done: the edited copy is saved as "plan (edited).docx", and the original "plan.docx" is unchanged.' });
    await waitFor(() => expect(document.querySelector(".agent-outcome")!.textContent).toContain("plan (edited).docx"));
    expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe('Change "shared drive" to "Q3 archive"');
  });

  it("a cancelled file dialog picks nothing; a picked window clears the document", async () => {
    const m = agentMocks();
    m.setDocPickReply(null); // the person cancelled the native dialog
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.change(ta, { target: { value: "task" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await screen.findByRole("listbox", { name: "Windows" });
    fireEvent.click(within(document.querySelector(".agent-picklist-head")!).getByRole("button", { name: "Edit a Word copy" }));
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Windows" })).toBeTruthy());
    expect(screen.queryByText(/an edited copy is saved beside the original/)).toBeNull();
    // picking a window instead clears any document target: at most one target
    const listbox = screen.getByRole("listbox", { name: "Windows" });
    fireEvent.click(listbox.querySelectorAll("[role='option']")[0]);
    await screen.findByText(/No window selected|Notepad:/);
    expect(screen.queryByText(/an edited copy is saved beside the original/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    await waitFor(() => expect(m.beginCalls).toEqual([1]));
    expect(m.docStarts).toHaveLength(0);
  });

  it("the idle target row offers Edit a Word copy directly; the review gate shows the EXACT change and the destination; Save answers true", async () => {
    const m = agentMocks();
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    // discoverable from the composer itself, BEFORE any picker is opened
    const idleRow = await screen.findByText("No window selected");
    expect(idleRow).toBeTruthy();
    const rowBtn = within(document.querySelector(".agent-picked-row")!).getByRole("button", { name: "Edit a Word copy" });
    expect(document.querySelector(".agent-picklist")).toBeNull(); // no picker needed
    fireEvent.change(ta, { target: { value: 'Change "shared drive" to "Q3 archive"' } });
    fireEvent.click(rowBtn);
    await screen.findByText(/an edited copy is saved beside the original/);
    // the draft typed BEFORE the pick survives it
    expect(ta.value).toBe('Change "shared drive" to "Q3 archive"');
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    await waitFor(() => expect(m.docStarts).toHaveLength(1));
    // the run reaches the gate: the exact find/replace and the destination file name
    emit(m.listeners, {
      runId: m.docStarts[0].id, status: "running", step: 3, phase: "review",
      line: 'The change is ready to review. On save it becomes "plan (edited).docx" beside the original.',
      review: { ops: [{ find: "shared drive", replace: "Q3 archive" }], summary: "Renames the drive in the paragraph.", sourceName: "plan.docx", destination: "plan (edited).docx" },
    });
    const card = await screen.findByRole("region", { name: "Review the proposed change" });
    expect(card.textContent).toContain("shared drive");
    expect(card.textContent).toContain("Q3 archive");
    expect(card.textContent).toContain('plan (edited).docx'); // the destination, BEFORE anything is written
    expect(within(card).getByRole("button", { name: "Save edited copy" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Save edited copy" }));
    await waitFor(() => expect(m.decideCalls).toEqual([{ id: m.docStarts[0].id, approved: true }]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Review the proposed change" })).toBeNull());
    // "Open edited copy" is offered ONLY on a done verdict that carried a path
    emit(m.listeners, { runId: m.docStarts[0].id, status: "done", phase: "settled", line: 'Done: the edited copy is saved as "plan (edited).docx".', copyPath: "C:\\docs\\plan (edited).docx" });
    const openBtn = await screen.findByRole("button", { name: "Open edited copy" });
    fireEvent.click(openBtn);
    await waitFor(() => expect(m.openCalls).toEqual(["C:\\docs\\plan (edited).docx"]));
  });

  it("Cancel on the review gate answers false; no Open edited copy without a done copyPath", async () => {
    const m = agentMocks();
    boot(m.api);
    const ta = await openChat();
    fireEvent.click(await screen.findByRole("button", { name: "Computer Use" }));
    fireEvent.click(within(document.querySelector(".agent-picked-row")!).getByRole("button", { name: "Edit a Word copy" }));
    await screen.findByText(/an edited copy is saved beside the original/);
    fireEvent.change(ta, { target: { value: "task" } });
    fireEvent.click(await screen.findByRole("button", { name: "Run task" }));
    await waitFor(() => expect(m.docStarts).toHaveLength(1));
    emit(m.listeners, {
      runId: m.docStarts[0].id, status: "running", step: 3, phase: "review",
      line: "The change is ready to review.",
      review: { ops: [{ find: "a", replace: "b" }], summary: "s", sourceName: "plan.docx", destination: "plan (edited).docx" },
    });
    await screen.findByRole("region", { name: "Review the proposed change" });
    fireEvent.click(within(document.querySelector(".agent-review")!).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(m.decideCalls).toEqual([{ id: m.docStarts[0].id, approved: false }]));
    // a done verdict WITHOUT a copyPath (nothing needed changing) offers no open button
    emit(m.listeners, { runId: m.docStarts[0].id, status: "done", phase: "settled", line: "Done: the document already satisfies the task." });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open edited copy" })).toBeNull());
  });
});
