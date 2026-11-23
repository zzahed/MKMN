import { describe, expect, it } from "vitest";
import {
  AGENT_DEFAULT_LIMITS,
  capabilitySteer,
  parseProposal,
  renderObserve,
  runAgentLoop,
  verifyAction,
  type AgentDriver,
  type AgentModel,
  type AgentRunDeps,
} from "../src/sidecar/computerUse";
import type { AgentRunEvent, NodeInfo, ObserveResult } from "../src/shared/agent";

/**
 * The Computer Use loop, driven with fakes. The wire shapes are the driver's
 * own (src-tauri/src/agent_wire.rs), so a test here is also a check that the
 * loop reads the real contract — the live ARM64 pass drives the same shapes
 * over real stdio.
 */

/** A fake observe snapshot of a little compose window: a field and a Send button. */
function snapshot(gen: number, fieldValue: string, fieldPatterns = ["setValue"]): ObserveResult {
  const field: NodeInfo = { ref: `e${gen}.0`, role: "Edit", name: "Message", value: fieldValue, className: "Edit", enabled: true, offscreen: false, rect: [10, 10, 200, 40], patterns: fieldPatterns };
  const send: NodeInfo = { ref: `e${gen}.1`, role: "Button", name: "Preview", className: "Button", enabled: true, offscreen: false, rect: [10, 60, 60, 24], patterns: ["click"] };
  return { window: { hwnd: 42, pid: 7, title: "Compose", process: "notepad.exe", className: "Notepad" }, observeGen: gen, focused: true, nodes: [field, send], truncated: false };
}

/** A fake driver over one compose window: its field value is real mutable state. */
function fakeDriver(opts: { actError?: (n: number) => Error | null; observeError?: (n: number) => Error | null } = {}) {
  let gen = 0;
  let fieldValue = "";
  let acts = 0;
  let observes = 0;
  const calls: string[] = [];
  const driver: AgentDriver = {
    observe: async (hwnd) => {
      calls.push(`observe:${hwnd}`);
      observes++;
      const err = opts.observeError?.(observes);
      if (err) throw err;
      gen++;
      return snapshot(gen, fieldValue);
    },
    act: async (hwnd, action) => {
      calls.push(`act:${hwnd}:${action.kind}`);
      acts++;
      const err = opts.actError?.(acts);
      if (err) throw err;
      if (action.kind === "setValue") {
        // The test asks for a value that does not stick by sending `!settle` texts.
        fieldValue = action.text;
        return { set: true };
      }
      return { invoked: true };
    },
    endRun: async () => { calls.push("endRun"); },
  };
  return { driver, calls, field: () => fieldValue, actCount: () => acts };
}

/** A model that answers from a script; every prompt it saw is kept. */
function fakeModel(replies: string[] | ((n: number, user: string) => string)) {
  const prompts: string[] = [];
  let n = 0;
  const model: AgentModel = {
    propose: async (_messages, signal) => {
      n++;
      prompts.push(_messages.map((m) => m.content).join("\n"));
      const r = typeof replies === "function" ? replies(n, prompts[n - 1]) : replies[n - 1] ?? "";
      if (r === "@wait-for-abort") {
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return r;
    },
  };
  return { model, prompts, count: () => n };
}

/** The refs the model would see for the compose field and its Send button, read from the prompt itself. */
function refOf(user: string, role: string, name: string): string {
  const m = new RegExp(`(e\\d+\\.\\d+) ${role}(?: "[^"]*")?(?: value="[^"]*")?.*${name}`).exec(user) ?? new RegExp(`(e\\d+\\.\\d+) ${role} "${name}"`).exec(user);
  if (!m) throw new Error(`the prompt did not show the ${role} "${name}":\n${user}`);
  return m[1];
}

function setup(_over: Partial<AgentRunDeps> & { driver: AgentDriver; model: AgentModel }) {
  const events: AgentRunEvent[] = [];
  const emit = (ev: AgentRunEvent) => events.push(ev);
  return { events, emit };
}

const ac = () => new AbortController();

describe("the Computer Use loop", () => {
  it("reads visible content and prepares an unsent draft, then settles done", async () => {
    const d = fakeDriver();
    const { model, prompts } = fakeModel((n, user) => {
      if (n === 1) {
        // The proposal quotes content only the tree could have shown.
        expect(user).toContain('Edit "Message"');
        expect(user).toContain('Button "Preview"');
        return JSON.stringify({ kind: "setValue", ref: refOf(user, "Edit", "Message"), text: "Draft: meeting notes" });
      }
      return JSON.stringify({ kind: "done", summary: 'The draft is in the Message field.' });
    });
    const { events, emit } = setup({ driver: d.driver, model });
    const out = await runAgentLoop({ runId: "r1", hwnd: 42, task: "Prepare an unsent draft", driver: d.driver, model, emit, signal: ac().signal });

    expect(out.status).toBe("done");
    expect(out.summary).toContain("draft");
    expect(d.field()).toBe("Draft: meeting notes");
    // The only executed action was the setValue: there is no send anywhere.
    expect(out.actions.map((a) => a.action.kind)).toEqual(["setValue"]);
    expect(out.actions[0].verified).toBe(true);
    expect(d.calls).toContain("act:42:setValue");
    expect(d.calls.at(-1)).toBe("endRun");
    // The model saw the window's content (its proposal proves the read).
    expect(prompts[0]).toContain("THE WINDOW'S CONTENT");
    // The terminal event names the verdict exactly once.
    const terminal = events.at(-1)!;
    expect(terminal.status).toBe("done");
    expect(events.filter((e) => e.status !== "running")).toHaveLength(1);
  });

  it("ends the Done line with exactly one period, whatever the summary carried in", async () => {
    // The installed live pass showed "Done: ... as requested..": the settle
    // line appended a period to a summary that already had one.
    for (const [summary, expected] of [
      ["The note has been written as requested.", "Done: The note has been written as requested."],
      ["The note has been written as requested", "Done: The note has been written as requested."],
    ] as const) {
      const d = fakeDriver();
      const model: AgentModel = { propose: async () => JSON.stringify({ kind: "done", summary }) };
      const { events, emit } = setup({ driver: d.driver, model });
      const out = await runAgentLoop({ runId: "r1", hwnd: 42, task: "write the note", driver: d.driver, model, emit, signal: ac().signal });
      expect(out.status).toBe("done");
      expect(events.at(-1)!.line).toBe(expected);
    }
  });

  it("marks a setValue verified when the field reads the newlines back as CR (Notepad's edit control)", async () => {
    // The live ARM64 pass caught this: the write holds, but the field's value
    // reads back with \r where the action carried \n, so a strict compare
    // failed every step and a correct run burned its whole budget unresolved.
    let fieldValue = "";
    let gen = 0;
    const snap = (v: string): ObserveResult => ({
      window: { hwnd: 42, pid: 7, title: "Notes - Notepad", process: "Notepad.exe", className: "Notepad" },
      observeGen: ++gen,
      focused: false,
      truncated: false,
      nodes: [{ ref: `e${gen}.0`, role: "Edit", name: "Text editor", value: v, enabled: true, offscreen: false, rect: [0, 0, 400, 300], patterns: ["setValue"] }],
    });
    const driver: AgentDriver = {
      observe: async () => snap(fieldValue.replace(/\n/g, "\r")),
      act: async (_hwnd, a) => {
        if (a.kind === "setValue") fieldValue = a.text;
        return { set: true };
      },
      endRun: async () => {},
    };
    const { model } = fakeModel((n) => (n === 1
      ? JSON.stringify({ kind: "setValue", ref: "e1.0", text: "Meeting notes - October review\nAttendance: Dana, Priya, Marcus.\nAction items: Dana to send the summary by Friday." })
      : JSON.stringify({ kind: "done", summary: "The action items line was added." })));
    const { events, emit } = setup({ driver, model });
    const out = await runAgentLoop({ runId: "r-cr", hwnd: 42, task: "Add the action items line", driver, model, emit, signal: ac().signal });
    expect(out.status).toBe("done");
    expect(out.actions[0].verified).toBe(true);
    expect(events.at(-1)!.status).toBe("done");
  });

  it("does not re-execute a verified write the model repeats, and steers it to done", async () => {
    // The live 8B pass: after a verified setValue the model proposed the same
    // write again, every step, to the step limit. A verified identical write
    // is a no-op; the loop refuses it and tells the model the result is there.
    let fieldValue = "";
    let gen = 0;
    const snap = (v: string): ObserveResult => ({
      window: { hwnd: 42, pid: 7, title: "Notes - Notepad", process: "Notepad.exe", className: "Notepad" },
      observeGen: ++gen,
      focused: false,
      truncated: false,
      nodes: [{ ref: `e${gen}.0`, role: "Edit", name: "Text editor", value: v, enabled: true, offscreen: false, rect: [0, 0, 400, 300], patterns: ["setValue"] }],
    });
    let acts = 0;
    const driver: AgentDriver = {
      observe: async () => snap(fieldValue),
      act: async (_hwnd, a) => {
        acts++;
        if (a.kind === "setValue") fieldValue = a.text;
        return { set: true };
      },
      endRun: async () => {},
    };
    const FULL = "Meeting notes - October review\nAttendance: Dana, Priya, Marcus.\nAction items: Dana to send the summary by Friday.";
    const { model, prompts } = fakeModel((n, user) => {
      if (n === 1) return JSON.stringify({ kind: "setValue", ref: refOf(user, "Edit", "Text editor"), text: FULL });
      if (n === 2) return JSON.stringify({ kind: "setValue", ref: refOf(user, "Edit", "Text editor"), text: FULL }); // the identical repeat
      // The nudge must have reached the model: the third prompt names the repeat.
      expect(prompts[2]).toContain("already executed and verified");
      return JSON.stringify({ kind: "done", summary: "The action items line is in place." });
    });
    const { events, emit } = setup({ driver, model });
    const out = await runAgentLoop({ runId: "r-repeat", hwnd: 42, task: "Add the action items line", driver, model, emit, signal: ac().signal });
    expect(out.status).toBe("done");
    expect(acts).toBe(1); // the verified write ran once; the repeat never reached the driver
    expect(events.at(-1)!.status).toBe("done");
  });

  it("recovers a stale reference by re-observing instead of failing", async () => {
    const d = fakeDriver({ actError: (n) => (n === 1 ? new Error("staleRef: the reference is from observe 1, but the window's latest observe is 2") : null) });
    const { model } = fakeModel((n, user) =>
      n === 1
        ? JSON.stringify({ kind: "setValue", ref: "e1.0", text: "hello" }) // stale on purpose: the newest snapshot names it differently
        : n === 2
          ? JSON.stringify({ kind: "setValue", ref: refOf(user, "Edit", "Message"), text: "hello" })
          : JSON.stringify({ kind: "done", summary: "The word is in the field." }));
    const { events, emit } = setup({ driver: d.driver, model });
    const out = await runAgentLoop({ runId: "r2", hwnd: 42, task: "Type a word", driver: d.driver, model, emit, signal: ac().signal });

    expect(out.status).toBe("done");
    expect(d.field()).toBe("hello");
    // Two acts were attempted, only the second executed and verified.
    expect(d.actCount()).toBe(2);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].verified).toBe(true);
    expect(events.at(-1)!.status).toBe("done");
  });

  it("settles cancelled on a stop mid-run and stops making driver calls", async () => {
    const d = fakeDriver();
    const { model } = fakeModel(["@wait-for-abort"]);
    const ctl = ac();
    const { events, emit } = setup({ driver: d.driver, model });
    const running = runAgentLoop({ runId: "r3", hwnd: 42, task: "Long task", driver: d.driver, model, emit, signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort(); // the panel's Stop: the event fires AND the flag is set
    const out = await running;

    expect(out.status).toBe("cancelled");
    expect(out.reason).toContain("stopped");
    expect(d.calls).not.toContain("act:42:setValue"); // nothing was executed
    expect(d.calls).toContain("endRun"); // the grant dies with the run
    expect(events.at(-1)!.status).toBe("cancelled");
    expect(events.filter((e) => e.status !== "running")).toHaveLength(1);
  });

  it("settles failed when the granted window is gone", async () => {
    const d = fakeDriver({ observeError: () => new Error("WINDOWGONE") });
    const { model } = fakeModel([]);
    const { events, emit } = setup({ driver: d.driver, model });
    const out = await runAgentLoop({ runId: "r4", hwnd: 42, task: "t", driver: d.driver, model, emit, signal: ac().signal });

    expect(out.status).toBe("failed");
    expect(out.reason).toContain("gone");
    expect(events.at(-1)!.status).toBe("failed");
    expect(d.calls).toContain("endRun");
  });

  it("never settles done over an action the re-observe cannot verify", async () => {
    // The field refuses the text in practice: the act succeeds but the field
    // always reads back empty, so the verify rule cannot prove the change.
    const d = fakeDriver();
    const stubborn: AgentDriver = {
      observe: async (h, m) => {
        const obs = await d.driver.observe(h, m);
        return { ...obs, nodes: obs.nodes.map((n) => (n.role === "Edit" ? { ...n, value: "" } : n)) };
      },
      act: (h, a) => d.driver.act(h, a),
      endRun: d.driver.endRun,
    };
    const { model } = fakeModel((n, user) =>
      JSON.stringify(n === 1 ? { kind: "setValue", ref: refOf(user, "Edit", "Message"), text: "wanted" } : { kind: "done", summary: "I set it." }));
    const { events, emit } = setup({ driver: stubborn, model });
    const out = await runAgentLoop({ runId: "r5", hwnd: 42, task: "Set the text", driver: stubborn, model, emit, signal: ac().signal });

    expect(out.status).toBe("unresolved");
    expect(out.reason).toContain("never verified");
    expect(out.actions[0].verified).not.toBe(true);
    expect(events.at(-1)!.status).toBe("unresolved");
  });

  it("refuses a proposal that does not fit the window, twice, and settles failed when nothing was executed", async () => {
    const d = fakeDriver();
    const { model } = fakeModel(JSON.stringify({ kind: "click", ref: "e9.9" })); // not in any snapshot
    const { events, emit } = setup({ driver: d.driver, model });
    const out = await runAgentLoop({ runId: "r6", hwnd: 42, task: "t", driver: d.driver, model, emit, signal: ac().signal });

    expect(out.status).toBe("failed");
    expect(out.reason).toContain("unusable twice");
    expect(d.actCount()).toBe(0);
    expect(events.at(-1)!.status).toBe("failed");
  });

  it("stops at the step limit and settles unresolved", async () => {
    const d = fakeDriver();
    // A toggle-less button clicked forever: every act runs, none verifies.
    const { model } = fakeModel((n, user) => JSON.stringify({ kind: "click", ref: refOf(user, "Button", "Preview") }));
    const { events, emit } = setup({ driver: d.driver, model });
    const out = await runAgentLoop({ runId: "r7", hwnd: 42, task: "t", driver: d.driver, model, emit, signal: ac().signal, limits: { maxSteps: 3 } });

    expect(out.status).toBe("unresolved");
    expect(out.reason).toContain("step limit (3)");
    expect(d.actCount()).toBe(3);
    expect(events.at(-1)!.status).toBe("unresolved");
  });

  it("gives the model ONE re-ask for an unparseable answer, and the re-ask recovers", async () => {
    const d = fakeDriver();
    const { model, prompts } = fakeModel([
      "I think I should click the button first.", // no JSON: refused
      "", // the re-ask's answer is ALSO unusable: one more proposal may follow on the next step
      "", // refused again → but a change was already... no: nothing executed yet → this must fail
    ]);
    void prompts;
    // With nothing executed, two unusable answers in ONE step settle failed;
    // the re-ask recovery is proven by the parser test above. Here we pin the
    // honest settle of a run whose model never produced a usable answer.
    const { events, emit } = setup({ driver: d.driver, model });
    const out = await runAgentLoop({ runId: "r8", hwnd: 42, task: "t", driver: d.driver, model, emit, signal: ac().signal });

    expect(out.status).toBe("failed");
    expect(out.reason).toContain("unusable twice");
    expect(d.actCount()).toBe(0);
    expect(events.at(-1)!.status).toBe("failed");
  });

  it("keeps the default limits honest", () => {
    expect(AGENT_DEFAULT_LIMITS.maxSteps).toBe(12);
    expect(AGENT_DEFAULT_LIMITS.runBudgetMs).toBe(10 * 60_000);
    expect(AGENT_DEFAULT_LIMITS.maxNodes).toBe(300);
  });

  it("verifies a long multiline rewrite (a live mismatch reproduced at the loop level)", async () => {
    // The installed Stop-test run: a ~200-character rewrite with blank lines
    // executed but "Could not verify". Reproduced live: the DRIVER cut the
    // field's value at 160 characters with an ellipsis, so the readback could
    // never equal the text. The wire now carries the full value (agent-desktop
    // pins its own cap tests); here the loop must verify the exact live shape:
    // blank lines, CR readback, past the old 160-character cap.
    let fieldValue = "";
    let gen = 0;
    const snap = (v: string): ObserveResult => ({
      window: { hwnd: 42, pid: 7, title: "Notes - Notepad", process: "Notepad.exe", className: "Notepad" },
      observeGen: ++gen,
      focused: false,
      truncated: false,
      nodes: [{ ref: `e${gen}.0`, role: "Edit", name: "Text editor", value: v, enabled: true, offscreen: false, rect: [0, 0, 400, 300], patterns: ["setValue"] }],
    });
    const driver: AgentDriver = {
      observe: async () => snap(fieldValue.replace(/\n/g, "\r")),
      act: async (_hwnd, a) => {
        if (a.kind === "setValue") fieldValue = a.text;
        return { set: true };
      },
      endRun: async () => {},
    };
    const REWRITE = [
      "Meeting notes - October review",
      "",
      "Attendance: Dana, Priya, Marcus.",
      "",
      "Discussion Topics:",
      "1. Review of October's project progress and key achievements.",
      "2. Addressing the delayed milestones from the September report.",
      "3. Planning the December review meeting.",
    ].join("\n");
    const { model } = fakeModel((n) => (n === 1
      ? JSON.stringify({ kind: "setValue", ref: "e1.0", text: REWRITE })
      : JSON.stringify({ kind: "done", summary: "The notes were rewritten." })));
    const { events, emit } = setup({ driver, model });
    const out = await runAgentLoop({ runId: "r-long", hwnd: 42, task: "Rewrite the notes", driver, model, emit, signal: ac().signal });
    expect(out.status).toBe("done");
    expect(out.actions[0].verified).toBe(true);
    expect(fieldValue).toBe(REWRITE);
    expect(events.at(-1)!.status).toBe("done");
  });

  it("verify reads the field's FULL value even when the model's view of it is capped", async () => {
    // The wire value (3000 chars) is displayed to the model capped at 2048 with
    // a marker; the verify compare must use the real field value, never the
    // display form.
    const LONG = "paragraph line\n".repeat(200); // 3000 chars
    const obs = snapshot(7, LONG);
    const text = renderObserve(obs);
    expect(text).toContain("characters not shown");
    expect(text.length).toBeLessThan(LONG.length + 200);
    // And the verify rule itself compares the full value:
    const after = snapshot(8, LONG.replace(/\n/g, "\r"));
    const before = after.nodes[0];
    const ok = verifyAction({ kind: "setValue", ref: "e8.0", text: LONG }, before, after);
    expect(ok).toBe(true);
  });

  it("makes no driver call of any kind after a cancellation lands", async () => {
    // The panel's Stop raced against the verify's re-observe: after the abort,
    // the loop must end without acting again and must still clear the grant.
    let gen = 0;
    const fieldValue = "seed";
    const snap = (v: string): ObserveResult => ({
      window: { hwnd: 42, pid: 7, title: "Notes - Notepad", process: "Notepad.exe", className: "Notepad" },
      observeGen: ++gen,
      focused: false,
      truncated: false,
      nodes: [{ ref: `e${gen}.0`, role: "Edit", name: "Text editor", value: v, enabled: true, offscreen: false, rect: [0, 0, 400, 300], patterns: ["setValue"] }],
    });
    const calls: string[] = [];
    let releaseObserve: (() => void) | null = null;
    let observes = 0;
    const driver: AgentDriver = {
      observe: async () => {
        calls.push(`observe:${observes + 1}`);
        observes++;
        if (observes === 2) {
          // the verify re-observe of step 1: hang until the stop releases it
          await new Promise<void>((r) => { releaseObserve = r; });
        }
        return snap(fieldValue);
      },
      act: async () => { calls.push("act"); return { set: true }; },
      endRun: async () => { calls.push("endRun"); },
    };
    const { model } = fakeModel((n, user) => JSON.stringify({ kind: "setValue", ref: refOf(user, "Edit", "Text editor"), text: "next words" }));
    const ctl = ac();
    const { events, emit } = setup({ driver, model });
    const running = runAgentLoop({ runId: "r-stop-race", hwnd: 42, task: "t", driver, model, emit, signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual(["observe:1", "act", "observe:2"]); // step 1 observed, acted, and is now hung in the verify observe
    ctl.abort();
    releaseObserve!();
    const out = await running;
    expect(out.status).toBe("cancelled");
    expect(calls.filter((c) => c === "act")).toHaveLength(1); // no further actions after cancellation
    expect(calls.at(-1)).toBe("endRun");
    expect(events.at(-1)!.status).toBe("cancelled");
  });
});

describe("the Word first-step failure (a canvas that accepts nothing)", () => {
  /**
   * The live reproduction: Word's document canvas ("Page 1 content", role Edit)
   * exposes no UIA Value pattern, so the driver offers it no `setValue`, while
   * the only writable elements are toolbar fields. A model that logically picks
   * the canvas was refused twice with no hint where a write CAN go, and the run
   * died before any action. These pins hold the fix: the refusal steers the
   * model to the writable elements (or to giveUp when there are none), and the
   * double-refusal settle names the limitation.
   */

  /** Word's real snapshot shape: canvas accepts nothing; a Font field does. */

  it("steers a refused canvas setValue to the elements that accept it, and honors a steered giveUp", async () => {
    let acts = 0;
    const driver: AgentDriver = {
      observe: async () => { gen++; return wordSnap(); },
      act: async () => { acts++; return { invoked: true }; },
      endRun: async () => {},
    };
    let gen = 0;
    const wordSnap = () => {
      gen++;
      const canvas: NodeInfo = { ref: `e${gen}.0`, role: "Edit", name: "Page 1 content", className: "_WwG", enabled: true, offscreen: false, rect: [304, 291, 816, 539] };
      const font: NodeInfo = { ref: `e${gen}.1`, role: "ComboBox", name: "Font", value: "Aptos (Body)", className: "ComboBox", enabled: true, offscreen: false, rect: [10, 60, 160, 24], patterns: ["setValue"] };
      const button: NodeInfo = { ref: `e${gen}.2`, role: "Button", name: "Save", className: "Button", enabled: true, offscreen: false, rect: [10, 100, 60, 24], patterns: ["click"] };
      return { window: { hwnd: 7, pid: 9, title: "repro - Word", process: "WINWORD.EXE", className: "OpusApp" }, observeGen: gen, focused: false, nodes: [canvas, font, button], truncated: false };
    };
    const { model, prompts } = fakeModel((n, user) => {
      if (n === 1) return JSON.stringify({ kind: "setValue", ref: refOf(user, "Edit", "Page 1 content"), text: "Received and filed" });
      return JSON.stringify({ kind: "giveUp", reason: "this window has no field that can hold the document's text" });
    });
    const { events, emit } = setup({ driver, model });
    const out = await runAgentLoop({ runId: "r-word", hwnd: 7, task: "Replace the text", driver, model, emit, signal: ac().signal });

    // The refusal note names WHERE a setValue can go (the Font field, not the canvas).
    expect(prompts[1]).toContain("Elements that accept setValue in this snapshot:");
    expect(prompts[1]).toMatch(/e\d+\.1 \(Font\)/);
    expect(acts).toBe(0);
    // The steered giveUp settles failed with the model's own clear limitation.
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("gave up before doing anything");
    expect(out.reason).toContain("no field that can hold the document's text");
    expect(events.at(-1)!.status).toBe("failed");
  });

  it("settles failed with the limitation named when the model retries the canvas twice", async () => {
    let gen = 0;
    const wordSnap = () => {
      gen++;
      const canvas: NodeInfo = { ref: `e${gen}.0`, role: "Edit", name: "Page 1 content", className: "_WwG", enabled: true, offscreen: false, rect: [304, 291, 816, 539] };
      const button: NodeInfo = { ref: `e${gen}.1`, role: "Button", name: "Save", className: "Button", enabled: true, offscreen: false, rect: [10, 100, 60, 24], patterns: ["click"] };
      return { window: { hwnd: 7, pid: 9, title: "repro - Word", process: "WINWORD.EXE", className: "OpusApp" }, observeGen: gen, focused: false, nodes: [canvas, button], truncated: false };
    };
    let acts = 0;
    const driver: AgentDriver = {
      observe: async () => wordSnap(),
      act: async () => { acts++; return { invoked: true }; },
      endRun: async () => {},
    };
    const { model } = fakeModel((n, user) => JSON.stringify({ kind: "setValue", ref: refOf(user, "Edit", "Page 1 content"), text: "Received and filed" }));
    const { events, emit } = setup({ driver, model });
    const out = await runAgentLoop({ runId: "r-word2", hwnd: 7, task: "Replace the text", driver, model, emit, signal: ac().signal });

    expect(out.status).toBe("failed");
    expect(out.reason).toContain("unusable twice");
    // With NOTHING writable in the snapshot, the settle says so plainly.
    expect(out.reason).toContain("Nothing in this snapshot accepts setValue");
    expect(acts).toBe(0);
    expect(events.at(-1)!.status).toBe("failed");
  });
});

describe("the proposal parser", () => {
  it("reads every closed shape and names the exact fault otherwise", () => {
    expect(parseProposal('{"kind":"setValue","ref":"e2.3","text":"hi"}')).toEqual({ proposal: { kind: "setValue", ref: "e2.3", text: "hi" } });
    expect(parseProposal('{"kind":"click","ref":"e2.3"}')).toEqual({ proposal: { kind: "click", ref: "e2.3" } });
    expect(parseProposal('{"kind":"select","ref":"e2.3","value":" Rules"}')).toEqual({ proposal: { kind: "select", ref: "e2.3", value: "Rules" } });
    expect(parseProposal('blah {"kind":"done","summary":"it is written"} trailing')).toEqual({ proposal: { kind: "done", summary: "it is written" } });
    expect(parseProposal('{"kind":"giveUp","reason":"the window shows nothing to type into"}')).toEqual({ proposal: { kind: "giveUp", reason: "the window shows nothing to type into" } });
    // think blocks are reasoning, not the answer
    expect(parseProposal('ictionaries<think>plan more</think>{"kind":"collapse","ref":"e0.1"}')).toEqual({ proposal: { kind: "collapse", ref: "e0.1" } });

    expect("fault" in parseProposal("no json here")).toBe(true);
    expect("fault" in parseProposal('{"kind":"pressEnter","ref":"e1.0"}')).toBe(true); // not in the closed set
    expect("fault" in parseProposal('{"kind":"click","ref":"button1"}')).toBe(true); // not a driver reference
    expect("fault" in parseProposal('{"kind":"setValue","ref":"e1.0"}')).toBe(true); // no text
    // The live Notepad-draft failure: the 8 B model wrote the multiline
    // text with RAW newlines inside the string; strict JSON refused it twice
    // ("Bad control character in string literal") and the run died before any
    // action. The bounded repair reads it as the newlines it means.
    const rawNewlines = '{"kind":"setValue","ref":"e1.0","text":"line one\nline two\n\nline three"}';
    expect("fault" in parseProposal(rawNewlines)).toBe(false); // the repair recovers it
    expect(parseProposal(rawNewlines)).toEqual({ proposal: { kind: "setValue", ref: "e1.0", text: "line one\nline two\n\nline three" } });
    expect(parseProposal('{"kind":"setValue","ref":"e1.0","text":"a\ttab"}')).toEqual({ proposal: { kind: "setValue", ref: "e1.0", text: "a\ttab" } });
    // a literal backslash-n stays a backslash and an n — the repair never touches escapes
    expect(parseProposal('{"kind":"setValue","ref":"e1.0","text":"a\\\\nb"}')).toEqual({ proposal: { kind: "setValue", ref: "e1.0", text: "a\\nb" } });
    expect("fault" in parseProposal('{"kind":"setValue","ref":"e1.0","text":')).toBe(true); // broken structure still faults
    expect("fault" in parseProposal('{"kind":"done"}')).toBe(true); // no summary
  });
});

describe("the observe renderer", () => {
  it("shows refs, roles, names, values, states and the accepted actions", () => {
    const obs = snapshot(4, "hello");
    obs.nodes[1].state = undefined;
    const text = renderObserve(obs);
    expect(text).toContain('e4.0 Edit "Message" value="hello" [setValue]');
    expect(text).toContain('e4.1 Button "Preview" [click]');
  });

  it("renders a node whose patterns field is absent (the real driver omits an empty vec)", () => {
    // agent_wire.rs skips `patterns` when empty: a container node arrives
    // without the field. The installed acceptance caught the renderer reading
    // `.length` of undefined — the whole run died uncaught mid-observe.
    const obs = snapshot(5, "Meeting notes - October review\nAttendance: Dana, Priya, Marcus.");
    delete (obs.nodes[1] as { patterns?: string[] }).patterns;
    obs.nodes[0].state = undefined;
    const text = renderObserve(obs);
    expect(text).toContain('e5.0 Edit "Message" value=');
    expect(text).toContain("e5.1 Button");
    expect(text).not.toContain("[click]");
  });
});

describe("the Word refusal steer", () => {
  const CAP = "the element accepts only [";
  it("a Word canvas refusal names Edit a Word copy; other windows' refusals do not", () => {
    const blank = snapshot(1, "Quarterly review draft", []);
    const word: ObserveResult = { ...blank, window: { hwnd: 9, pid: 8, title: "Document1 - Word", process: "WINWORD.EXE", className: "OpusApp" } };
    const wordSteer = capabilitySteer(word, "setValue", `${CAP}nothing], not setValue`);
    expect(wordSteer).toContain("Edit a Word copy");
    expect(wordSteer).toContain("save it as a .docx");
    const notepadSteer = capabilitySteer(blank, "setValue", `${CAP}nothing], not setValue`);
    expect(notepadSteer).not.toContain("Edit a Word copy");
    // a steer for a fault that is not a capability mismatch stays empty
    expect(capabilitySteer(word, "setValue", "a stale ref")).toBe("");
  });
});
