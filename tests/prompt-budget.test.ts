import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fitMessages, promptTokens, replyReserve, tokensOf } from "../src/core/context";
import { buildSystemPrompt } from "../src/core/projects";
import { routeVisual } from "../src/core/visualRoute";
import { parsePlan } from "../src/core/build";
import { VOICE_RULES } from "../src/core/artifacts";

/**
 * The app's own instructions must never be what makes a request fail, on any route and any window:
 * the design in docs/design/design-prompt-budget.md. Every instruction block is registered with a priority
 * and a relevance rule; the request is assembled inside a budget computed from the served window,
 * and what cannot fit is dropped whole, down to a minimal core, before anything is refused.
 */

const WINDOWS = [2048, 4096, 8192, 16384] as const;
const HELLO = "write me a program for hello world";
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** The new module, loaded lazily so the other contracts fail for their own reason while it does not exist yet. */
const prompts = () => import("../src/core/prompts");

describe("the instruction budget", () => {
  it("leaves the person's question room at every window, and never takes more than half the window for itself", async () => {
    const { instructionBudgetFor } = await prompts();
    for (const nctx of WINDOWS) {
      const budget = nctx - replyReserve(nctx, 4096);
      const instructions = instructionBudgetFor(nctx, 4096, 0, 0);
      expect(instructions).toBeLessThanOrEqual(Math.floor(nctx / 2));
      expect(instructions, `window ${nctx}`).toBeGreaterThan(0);
      expect(budget - instructions, `window ${nctx}: room for the question`).toBeGreaterThanOrEqual(256);
    }
  });
  it("shrinks as the conversation and the appends grow, never below the minimal core", async () => {
    const { instructionBudgetFor, CORE_FLOOR } = await prompts();
    const empty = instructionBudgetFor(4096, 4096, 0, 0);
    const withConversation = instructionBudgetFor(4096, 4096, 1000, 0);
    expect(withConversation).toBeLessThan(empty);
    expect(instructionBudgetFor(4096, 4096, 1000, 771)).toBeLessThan(withConversation); // search + images + sub-agents
    expect(instructionBudgetFor(4096, 4096, 100_000, 0)).toBe(CORE_FLOOR);
    expect(CORE_FLOOR).toBeGreaterThanOrEqual(400); // the core itself (voice + artifact + edit format) measured
  });
});

describe("the assembled instructions", () => {
  const FULL = { artifacts: true, office: true, drawn: true, visual: null, web: true, images: true, agents: true };

  it("never exceed their budget, and the core (who speaks, the artifact format, the edit blocks) is always kept", async () => {
    const { assembleInstructions, instructionBudgetFor } = await prompts();
    for (const nctx of WINDOWS) {
      const budget = instructionBudgetFor(nctx, 4096, 0, 0);
      const a = assembleInstructions(FULL, budget);
      expect(a.tokens, `window ${nctx}`).toBeLessThanOrEqual(budget);
      expect(a.text).toContain("You are one assistant");
      expect(a.text).toContain("<artifact");
      expect(a.text).toContain("<<<<<<< SEARCH");
      if (a.dropped.includes("office")) expect(a.text).not.toContain("pptx = slides");
    }
  });
  it("drop whole blocks, never a cut rule: what is dropped is absent, what is kept is complete", async () => {
    const { assembleInstructions, instructionBudgetFor } = await prompts();
    const tiny = assembleInstructions(FULL, 700); // only the core fits
    const full = assembleInstructions(FULL, 100_000);
    expect(tiny.tokens).toBeLessThanOrEqual(700);
    expect(full.tokens).toBeGreaterThan(tiny.tokens);
    // a block of the full assembly is either whole in the tiny one or fully absent: never a cut rule
    for (const block of full.text.split("\n\n")) {
      if (!block.trim()) continue;
      if (tiny.text.includes(block.slice(0, 60))) expect(tiny.text, block.slice(0, 60)).toContain(block);
    }
  });
});

describe("the finished request on every route", () => {
  // The gate that refuses a request is `promptTokens` on the messages that are actually sent:
  // system message included, one +4 per message, and the sidecar's appends joined on top.
  // The bug was arithmetic that did not agree with that gate: instructions were capped at
  // nctx/2 but measured at 2088 in a 2048-token room, an append survived a zero budget, and
  // the orchestrator subtracted the system prompt twice.
  it("the system prompt plus every tool append fits what the request can carry, at every window and file answer", async () => {
    const { appendInstructions } = await prompts();
    for (const nctx of [2048, 4096, 8192] as const) {
      const budget = Math.max(512, nctx - replyReserve(nctx, 4096));
      for (const fileKind of [null, "docx", undefined] as const) {
        for (const web of [false, true]) {
          for (const question of [HELLO, "word ".repeat(Math.floor(budget / 2))]) {
            const qm = [{ role: "user" as const, content: question }];
            const conversationTokens = promptTokens(qm);
            const sys = buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind, contextTokens: nctx, conversationTokens });
            const used = promptTokens([{ role: "system", content: sys }, ...qm]);
            const appends = appendInstructions({ artifacts: false, office: false, drawn: false, visual: null, web, images: web, agents: web }, nctx, used);
            const messages = [
              { role: "system" as const, content: appends.text ? `${sys}\n\n${appends.text}` : sys },
              ...qm
            ];
            expect(promptTokens(messages), `window ${nctx}, file ${String(fileKind)}, web ${web}, question ${question.length} chars`).toBeLessThanOrEqual(budget);
          }
        }
      }
    }
  });
  it("an append budget of zero keeps no append at all", async () => {
    const { appendInstructions } = await prompts();
    const r = appendInstructions({ artifacts: false, office: false, drawn: false, visual: null, web: true, images: true, agents: true }, 2048, 2048);
    expect(r.tokens).toBe(0);
    expect(r.text).toBe("");
  });
  it("the joined instruction text is measured, not the sum of the blocks", async () => {
    const { assembleInstructions, instructionBudgetFor } = await prompts();
    const all = { artifacts: true, office: true, drawn: true, visual: null, web: true, images: true, agents: true };
    for (const nctx of [2048, 4096, 8192] as const) {
      const budget = instructionBudgetFor(nctx, 4096, 0, 0);
      const a = assembleInstructions(all, budget);
      expect(tokensOf(a.text), `window ${nctx}: the registry reported ${a.tokens} tokens, the text measures ${tokensOf(a.text)}`).toBeLessThanOrEqual(budget);
    }
  });
  it("the orchestrator budgets the appends against the request once, not with the system prompt counted twice", () => {
    const orch = read("src/core/chatOrchestrator.ts");
    expect(orch).not.toContain("promptTokens(lean) + tokensOf(sysText)");
  });
});

describe("the chat system prompt", () => {
  it("the hello-world request fits at 4096 with room for its answer (the regression)", () => {
    const sys = buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: null, contextTokens: 4096 });
    const messages = [{ role: "system" as const, content: sys }, { role: "user" as const, content: HELLO }];
    const budget = 4096 - replyReserve(4096, 4096); // 2,868 — the request measured 3,075 before
    expect(promptTokens(messages), "the request must reach the model").toBeLessThanOrEqual(budget);
    expect(sys).toContain("<<<<<<< SEARCH"); // the core edit format is never dropped
  });
  it("fits at every window, for every kind of route, with room for the answer", () => {
    const routes: Record<string, (nctx: number) => string> = {
      "a program (hello world)": (nctx) => buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: null, contextTokens: nctx }),
      "an office document": (nctx) => buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: "docx", contextTokens: nctx }),
      "a chart in the chat": (nctx) => buildSystemPrompt({ knowledgeChars: 0, artifacts: true, visual: routeVisual("draw a chart of my monthly expenses"), contextTokens: nctx }),
      "everything on (web, images, sub-agents, office, unsure file kind)": (nctx) =>
        buildSystemPrompt({ knowledgeChars: 0, artifacts: true, contextTokens: nctx, web: true, images: true, agents: true }),
      "a greeting": (nctx) => buildSystemPrompt({ knowledgeChars: 0, artifacts: false, contextTokens: nctx })
    };
    for (const [route, make] of Object.entries(routes)) {
      for (const nctx of WINDOWS) {
        const sys = make(nctx);
        const messages = [{ role: "system" as const, content: sys }, { role: "user" as const, content: HELLO }];
        const budget = Math.max(512, nctx - replyReserve(nctx, 4096));
        expect(promptTokens(messages), `${route} at ${nctx}`).toBeLessThanOrEqual(budget);
      }
    }
  });
  it("the finished request, appends included, passes the same gate that measures it in the end (streamComplete)", async () => {
    // The sidecar stacks the tools' rules (search, pictures, sub-agents) on the renderer's system prompt and the
    // whole request is measured once more by fitMessages before it is sent: when the appends take every token
    // left, the estimate's own error must not push the request past that gate (this refused a request that fit).
    const { appendInstructions } = await prompts();
    for (const nctx of WINDOWS) {
      const sys = buildSystemPrompt({ knowledgeChars: 0, artifacts: true, contextTokens: nctx, conversationTokens: 0, fileKind: undefined });
      const appends = appendInstructions({ artifacts: false, office: false, drawn: false, visual: null, web: true, images: true, agents: true }, nctx, promptTokens([{ role: "system", content: sys }]));
      const messages = [
        { role: "system" as const, content: appends.text ? `${sys}\n\n${appends.text}` : sys },
        { role: "user" as const, content: HELLO }
      ];
      const budget = Math.max(512, nctx - replyReserve(nctx, 4096));
      expect(promptTokens(messages), `web + images + sub-agents at ${nctx} (appends kept: ${appends.dropped.length ? "some dropped: " + appends.dropped.join(", ") : "all"})`).toBeLessThanOrEqual(budget);
    }
  });
  it("keeps the office rules when the request is for a document or a sheet, or unsure, and drops them when the answer is a definite no", () => {
    const dropped = buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: null, contextTokens: 16384 });
    expect(dropped).not.toContain("pptx = slides"); // "none" is a definite answer: dropped even with room to spare
    expect(dropped).not.toContain("xlsx =");
    const kept = buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: "docx", contextTokens: 4096 });
    expect(kept).toContain("pptx = slides");
    const sheet = buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: "xlsx", contextTokens: 4096 });
    expect(sheet).toContain("xlsx =");
    const unsure = buildSystemPrompt({ knowledgeChars: 0, artifacts: true, contextTokens: 4096 }); // no answer: inclusion is the default
    expect(unsure).toContain("pptx = slides");
  });
  it("a file-heavy conversation shrinks the instructions to the core and still fits, at every window", () => {
    const game = `<artifact type="html" title="Snake">\n${"<div>x</div>\n".repeat(180)}\n</artifact>`;
    const conversation = [{ role: "user" as const, content: "make me a snake game" }, { role: "assistant" as const, content: game }];
    const question = "add a pause button";
    for (const nctx of WINDOWS) {
      const conversationTokens = promptTokens(conversation);
      const sys = buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: null, contextTokens: nctx, conversationTokens });
      expect(tokensOf(sys), `window ${nctx}: the instructions shrink`).toBeLessThanOrEqual(700);
      const messages = [{ role: "system" as const, content: sys }, ...conversation, { role: "user" as const, content: question }];
      const fit = fitMessages(messages, nctx - replyReserve(nctx, 4096));
      expect(fit.overflow, `window ${nctx}`).toBe(false);
    }
  });
});

describe("the construction engine keeps every program", () => {
  it("an unusable planner reply for a program still builds one file, it does not fall back to the chat", () => {
    const plan = parsePlan("hmm", [], HELLO);
    expect(plan.mode).toBe("build");
    expect(plan.files).toEqual([expect.objectContaining({ name: "index.html", action: "new" })]);
  });
});

describe("the overflow notice", () => {
  it("names the real parts and never tells a short question to shorten itself", () => {
    const sys = `${VOICE_RULES}\n${"You follow these rules. ".repeat(600)}`;
    const fit = fitMessages([{ role: "system", content: sys }, { role: "user", content: "hi" }], 1434);
    expect(fit.overflow).toBe(true);
    const note = fit.notes.join(" ");
    expect(note).toMatch(/system prompt/i);
    expect(note).toMatch(/question/i);
    expect(note).toMatch(/\d{3,}/); // the real sizes are in it
    expect(note).not.toMatch(/shorten/i);
    expect(note).toMatch(/new chat|bigger window/i);
  });
  it("when the question itself is what does not fit, it says so", () => {
    const fit = fitMessages([{ role: "user", content: "word ".repeat(4000) }], 1434);
    expect(fit.overflow).toBe(true);
    expect(fit.notes.join(" ")).toMatch(/shorten/i);
  });
});

describe("the registry is complete", () => {
  /** Single-route prompts of their own sessions, each measured small on its own route: not part of the budgeted chat prompt. */
  const EXEMPT: Record<string, string> = {
    ARTIFACT_INSTRUCTIONS: "kept as the join of the registered artifact parts, for the construction engine's writer and editor sessions",
    WORKER_INSTRUCTIONS: "the sub-agent worker's own session prompt (64 tokens, one route)",
    PLANNER_INSTRUCTIONS: "the construction engine's planner (own session)",
    IMPROVER_INSTRUCTIONS: "the file improver's own session",
    SPEC_INSTRUCTIONS: "the build's rules session, which writes a program's rules before it is coded (src/core/build.ts)",
    ARTIST_INSTRUCTIONS: "the page writer's art session",
    OUTLINE_INSTRUCTIONS: "the page writer's outline session",
    WRITE_INSTRUCTIONS: "the page writer's write session",
    REPAIR_INSTRUCTIONS: "the page repair session",
    SPLIT_INSTRUCTIONS: "the page splitter session",
    SPLIT_PARTS_INSTRUCTIONS: "the page splitter session",
    STYLE_CARD_INSTRUCTIONS: "the page style session",
    ACTIONS_INSTRUCTIONS: "construct: docs sessions",
    CALC_INSTRUCTIONS: "construct: docs sessions",
    CHANGE_INSTRUCTIONS: "construct: docs sessions",
    CONVENTIONS_INSTRUCTIONS: "construct: docs sessions",
    GAPS_INSTRUCTIONS: "construct: docs sessions",
    PLAN_INSTRUCTIONS: "construct: docs sessions",
    REQUIREMENTS_INSTRUCTIONS: "construct: docs sessions",
    SCREEN_INSTRUCTIONS: "construct: docs sessions",
    SHARED_INSTRUCTIONS: "construct: docs sessions",
    STRUCTURE_INSTRUCTIONS: "construct: docs sessions",
    STYLE_INSTRUCTIONS: "construct: docs sessions",
    WIRING_INSTRUCTIONS: "construct: docs sessions",
    WIRING_REVIEW_INSTRUCTIONS: "construct: docs sessions",
    WRITE_RULES: "construct: docs sessions",
    STRICT_RULES: "construct: docs sessions",
    ART_RULES: "construct: the art session",
    SCENARIO_INSTRUCTIONS: "construct: the scenario session",
    DESCRIBE_INSTRUCTIONS: "the vision describe session",
    EDITOR_INSTRUCTIONS: "the construction engine's editor session",
    REVIEWER_INSTRUCTIONS: "the answer reviewer's own session",
    LOCATOR_INSTRUCTIONS: "the PDF locator session",
    LOOK_INSTRUCTIONS: "the screenshot judge session",
    LOOK_SLIDE: "the slide judge session (not matched here; kept for the next scan to catch typos)",
    CHART_INSTRUCTIONS: "carried by the registered visual blocks (visualRules, VISUAL_OVERVIEW)",
    CHART_CALC_INSTRUCTIONS: "carried by the registered visual blocks (visualRules)",
    CHART_FIX_INSTRUCTIONS: "the chart mend session",
    DIAGRAM_INSTRUCTIONS: "carried by the registered visual blocks (visualRules, VISUAL_OVERVIEW)",
    GAME_INSTRUCTIONS: "the game engine session",
    DECK_PLANNER: "the deck planner session",
    SLIDE_WRITER: "the deck slide writer session",
    FILL_INSTRUCTIONS: "the template fill session"
  };
  it("every instruction constant in src/core is registered with a priority and a relevance rule, or exempted with a reason", async () => {
    const { INSTRUCTION_BLOCKS } = await prompts();
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") ? [p] : [];
      });
    const found = new Set<string>();
    for (const f of walk("src/core")) {
      for (const m of read(f).matchAll(/export const ([A-Z][A-Z0-9_]*(?:INSTRUCTIONS|RULES|OVERVIEW|PLANNER|WRITER))\b/g)) found.add(m[1]);
    }
    const registered = new Set(INSTRUCTION_BLOCKS.flatMap((b) => (b.covers ?? "").split(",").map((s) => s.trim()).filter(Boolean)));
    for (const name of [...found].sort()) {
      expect(registered.has(name) || name in EXEMPT, `${name}: register it in INSTRUCTION_BLOCKS (with a priority and a relevance rule) or add it to EXEMPT with a reason`).toBe(true);
    }
    expect([...registered]).toEqual(expect.arrayContaining(["VOICE_RULES", "ARTIFACT_INSTRUCTIONS", "VISUAL_OVERVIEW", "BLOCK_INSTRUCTIONS", "SUBAGENT_INSTRUCTIONS", "SEARCH_INSTRUCTIONS", "IMAGE_INSTRUCTIONS"]));
  });
  it("every registered block carries a priority, a relevance rule, and is never bigger than what a 2048 window can hold", async () => {
    const { INSTRUCTION_BLOCKS, instructionBudgetFor } = await prompts();
    const room = instructionBudgetFor(2048, 4096, 0, 0);
    for (const b of INSTRUCTION_BLOCKS) {
      expect(typeof b.priority, `${b.name}: priority`).toBe("number");
      expect(typeof b.when, `${b.name}: relevance rule`).toBe("function");
      const text = typeof b.text === "string" ? b.text : b.text({ artifacts: true, office: true, drawn: true, visual: { kind: "chart", why: "" }, web: true, images: true, agents: true });
      expect(text.trim(), `${b.name}: text`).not.toBe("");
      expect(tokensOf(text), `${b.name}: must fit a 2048 window's instruction budget`).toBeLessThanOrEqual(room);
    }
  });
});

describe("the window is one number, decided in one place", () => {
  it("the host decides it and logs the size with the reason at serve start", () => {
    const sup = read("src-tauri/src/supervisor.rs");
    expect(sup).toContain("req.nctx.unwrap_or_else(|| recommended_nctx.unwrap_or(4096))");
    expect(sup).toMatch(/Context window: \{\} tokens \(\{\}\)/); // "<n> tokens (<reason>); recommends <m>"
  });
  it("the RAM tiers that choose it have their own test", () => {
    const est = read("src-tauri/src/memory_estimator.rs");
    expect(est).toMatch(/fn \w*tier\w*\(\)/);
    expect(est).toContain("8192");
    expect(est).toContain("2048");
  });
  it("the sidecar budgets against the served window, never against the catalog's recommendation", () => {
    const orch = read("src/core/chatOrchestrator.ts");
    expect(orch).not.toContain("?? entry.recommendedContext");
    expect(orch).not.toContain("?? re.recommendedContext");
    const side = read("src/sidecar/main.ts");
    expect(side).toContain("servedNctx");
    expect(side).not.toContain("nctx: srv.status().nctx ?? entry.recommendedContext");
  });
  it("the renderer sends with the window its meter shows, and asks the closed file question before building the prompt", () => {
    const chat = read("src/renderer/Chat.tsx");
    expect(chat).not.toContain("target.verdict.contextTokens || 4096");
    expect(chat).toContain("historyFor(ask, sent, limit");
    expect(chat).toContain("routerFileKind");
    expect(read("src/renderer/tauriBridge.ts")).toContain("routerFileKind");
    expect(read("src/renderer/mock.ts")).toContain("routerFileKind");
  });
});

describe("a build failure is shown, never silently answered with the biggest prompt", () => {
  it("the orchestrator announces the fallback and budgets its appends through the registry", () => {
    const orch = read("src/core/chatOrchestrator.ts");
    expect(orch).toContain("Planning did not finish");
    expect(orch).toContain("appendInstructions");
    expect(orch).not.toContain("withSystem(lean, SEARCH_INSTRUCTIONS)");
    const build = read("src/core/build.ts");
    expect(build).toMatch(/(?:interface|type) StepwiseResult[\s\S]{0,300}reason/);
  });
});

describe("the housekeeping rule is written down", () => {
  it("CONTRIBUTING.md says every new instruction block needs a priority and must pass the budget test", () => {
    const contributing = read("CONTRIBUTING.md");
    expect(contributing).toMatch(/Every prompt change/i);
    expect(contributing).toMatch(/priority/i);
    expect(contributing).toMatch(/budget/i);
  });
});
