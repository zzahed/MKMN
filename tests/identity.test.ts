import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readZip } from "../src/core/zip";
import { buildOffice } from "../src/core/office";
import { buildSystemPrompt } from "../src/core/projects";
import { assembleInstructions } from "../src/core/prompts";
import { guardAnswerText, guardSentence, IdentityStreamGuard, IdentityEventGuard, withIdentity, ASSISTANT_NAME, IDENTITY_INSTRUCTIONS } from "../src/core/harness/identity";
import { withAnswer } from "../src/core/chat";
import type { ChatEvent } from "../src/shared/types";
import { INSTRUCTION_BLOCKS } from "../src/core/prompts";
import identityNames from "../src/core/harness/identity-names.json";

/**
 * The assistant is MKMN AI and says no other name. Three layers are pinned here:
 * the identity block in every route's assembled prompt (also after a compaction),
 * the guard on the answers (whole text and streamed across chunks), and the
 * user-facing names of the app itself.
 */

const FORBIDDEN = [
  ...(identityNames.models as string[]),
  ...(identityNames.engines as string[]),
  ...(identityNames.makers as string[]),
  ...(identityNames.arabicMakers as string[]),
].filter((n) => n !== ASSISTANT_NAME);

describe("the identity block in every route's prompt", () => {
  it("is registered with the top priority and is relevant everywhere", () => {
    const block = INSTRUCTION_BLOCKS.find((b) => b.name === "identity");
    expect(block).toBeTruthy();
    expect(block!.priority).toBe(Math.max(...INSTRUCTION_BLOCKS.map((b) => b.priority)));
    expect(block!.when({ artifacts: false, office: false, drawn: false, visual: null, web: false, images: false, agents: false })).toBe(true);
  });

  it("is in every route's assembled system prompt, at every window", () => {
    const routes: Record<string, (nctx: number) => string> = {
      "a program": (nctx) => buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: null, contextTokens: nctx }),
      "an office document": (nctx) => buildSystemPrompt({ knowledgeChars: 0, artifacts: true, fileKind: "docx", contextTokens: nctx }),
      "a greeting": (nctx) => buildSystemPrompt({ knowledgeChars: 0, artifacts: false, contextTokens: nctx }),
    };
    for (const [route, make] of Object.entries(routes)) {
      for (const nctx of [2048, 4096, 16384]) {
        expect(make(nctx), `${route} at ${nctx}`).toContain(IDENTITY_INSTRUCTIONS.split("\n")[0]);
      }
    }
  });

  it("survives a compaction: the smallest budget still keeps it whole, and withIdentity re-sends it fresh", () => {
    // After a compaction the instructions are re-sent fresh, never summarized: even a
    // budget that drops everything else keeps the identity block.
    const a = assembleWithIdentity(120);
    expect(a).toContain(IDENTITY_INSTRUCTIONS.split("\n")[0]);
    expect(withIdentity("Existing system text")).toBe(`${IDENTITY_INSTRUCTIONS}\n\nExisting system text`);
    expect(withIdentity(IDENTITY_INSTRUCTIONS)).toBe(IDENTITY_INSTRUCTIONS); // idempotent, never doubled
  });

  function assembleWithIdentity(budget: number): string {
    // The same call the system-prompt builder makes at its tightest: the identity block is
    // the first block considered and the first kept block is never dropped.
    return assembleInstructions({ artifacts: true, office: true, drawn: true, visual: null, web: false, images: false, agents: false }, budget).text;
  }
});

describe("the guard on the answers", () => {
  it("'I am Qwen, made by Alibaba' becomes 'I am MKMN AI'", () => {
    expect(guardAnswerText("I am Qwen, made by Alibaba.")).toBe("I am MKMN AI.");
    expect(guardAnswerText("I'm Qwen.")).toBe("I'm MKMN AI.");
    expect(guardAnswerText("I was created by Meta.")).toBe("I am MKMN AI.");
    expect(guardSentence("I am powered by the Qwen model.")).toBe("I am powered by the MKMN AI model.");
  });

  it("the same in Arabic, with the name kept in Latin letters", () => {
    expect(guardAnswerText("أنا Qwen، تم تطويري بواسطة علي بابا.")).toBe("أنا MKMN AI.");
    expect(guardAnswerText("اسمي Qwen.")).toBe("اسمي MKMN AI.");
    expect(guardAnswerText("أنا مساعد Qwen.")).toBe("أنا مساعد MKMN AI.");
  });

  it("a name split across stream chunks is still caught, on the text the screen and the voice read", () => {
    const g = new IdentityStreamGuard();
    const out = [g.push("Hello! I am Qw"), g.push("en, made by Al"), g.push("ibaba. What can I do for you?"), g.flush()].join("");
    expect(out).toContain("I am MKMN AI.");
    expect(FORBIDDEN.filter((n) => out.includes(n))).toEqual([]);
    expect(out).toContain("What can I do for you?");
  });

  it("never touches a sentence where another product is the topic", () => {
    const topic = "Qwen and Llama are both open models.";
    expect(guardAnswerText(topic)).toBe(topic);
    const mixed = "Qwen and Llama are both open models. I am Qwen, made by Alibaba.";
    expect(guardAnswerText(mixed)).toBe("Qwen and Llama are both open models. I am MKMN AI.");
    // A denial is the truth already: never rewritten into a false claim.
    expect(guardAnswerText("No, I am not Qwen.")).toBe("No, I am not Qwen.");
    // An answer about other products keeps its every word.
    const compare = "Compare Llama and Qwen: Llama 3 has 8B parameters, while Qwen2.5 has 7B.";
    expect(guardAnswerText(compare)).toBe(compare);
  });

  it("an unnamed self-description becomes the fixed answer, in the sentence's own script (the two misses of the 7b real runs)", () => {
    // a recorded run, identity-maker-ar: the answer named NO name at all, so
    // there was nothing for the name rewrite to catch, and it went out as it was.
    expect(guardAnswerText("أنا مساعد رقمي على هذا الكمبيوتر، خلقت بواسطة الذكاء الاصطناعي."))
      .toBe("أنا MKMN AI، مساعدك على هذا الكمبيوتر.");
    // identity-compact-ar: the same shape, and the question after it is kept.
    expect(guardAnswerText("أنا مساعد رقمي خاص بك، يعمل على هذا الكمبيوتر الخاص بك. كيف يمكنني مساعدتك اليوم؟"))
      .toBe("أنا MKMN AI، مساعدك على هذا الكمبيوتر. كيف يمكنني مساعدتك اليوم؟");
    // The same shape in English, with a generic maker clause folded in.
    expect(guardAnswerText("I am a digital assistant on this computer, created by artificial intelligence."))
      .toBe("I am MKMN AI, your assistant on this PC.");
    expect(guardAnswerText("I'm just a virtual assistant here to help."))
      .toBe("I am MKMN AI, your assistant on this PC.");
    // A denial is the truth already, and a sentence that does not open as a self-description is never touched.
    expect(guardAnswerText("أنا لست مساعدًا عاديًا.")).toBe("أنا لست مساعدًا عاديًا.");
    expect(guardAnswerText("I am not just a chatbot.")).toBe("I am not just a chatbot.");
  });
});

describe("the stream guard over the chat's events", () => {
  it("a self-naming sentence is taken back across chunk boundaries and re-sent corrected; the words still arrive live", () => {
    const g = new IdentityEventGuard("t");
    let answer = "";
    const feed = (evs: ChatEvent[]) => { for (const ev of evs) if (ev.type === "answer" || ev.type === "retract") answer = withAnswer(answer, ev); };
    // the deltas flow live as they come: each forwarded before any take-back
    feed(g.event({ id: "t", type: "answer", text: "Hello! I am Qw" }));
    feed(g.event({ id: "t", type: "answer", text: "en, made by Al" }));
    expect(answer).toBe("Hello! I am Qwen, made by Al"); // live, not yet corrected
    feed(g.event({ id: "t", type: "answer", text: "ibaba. What can I do?" }));
    expect(answer).not.toBe("Hello! I am Qwen, made by Alibaba. What can I do?"); // the sentence did not stand
    feed(g.event({ id: "t", type: "done", stats: { ttftSec: 0.1, tokPerSec: 10, tokens: 3, totalSec: 1 } }));
    expect(answer).toBe("Hello! I am MKMN AI. What can I do?");
  });

  it("the guarded text is what the run journals: a retract and the corrected sentence rebuild the reply", () => {
    const g = new IdentityEventGuard("t");
    let answer = "";
    const feed = (evs: ChatEvent[]) => { for (const ev of evs) if (ev.type === "answer" || ev.type === "retract") answer = withAnswer(answer, ev); };
    feed(g.event({ id: "t", type: "answer", text: "I am Qw" }));
    feed(g.event({ id: "t", type: "answer", text: "en. Hello!" }));
    feed(g.event({ id: "t", type: "done", stats: { ttftSec: 0.1, tokPerSec: 10, tokens: 3, totalSec: 1 } }));
    expect(answer).toBe("I am MKMN AI. Hello!");
  });

  it("a transport retract lands on the same words in guarded space, and the guard starts from the cut", () => {
    const g = new IdentityEventGuard("t");
    let answer = "";
    const feed = (evs: ChatEvent[]) => { for (const ev of evs) if (ev.type === "answer" || ev.type === "retract") answer = withAnswer(answer, ev); };
    // a guarded sentence made the person's text SHORTER than the raw answer was
    feed(g.event({ id: "t", type: "answer", text: "Fine. I am Qwen, made by Alibaba." }));
    expect(answer).toContain("MKMN AI");
    // the transport takes the answer back to raw position 6 ("Fine. "): guarded space has the same words there
    feed(g.event({ id: "t", type: "retract", keep: 6 }));
    expect(answer).toBe("Fine. ");
    // the continuation is guarded from the cut
    feed(g.event({ id: "t", type: "answer", text: "I am Qwen, made by Alibaba." }));
    feed(g.event({ id: "t", type: "done", stats: { ttftSec: 0.1, tokPerSec: 10, tokens: 3, totalSec: 1 } }));
    expect(answer).toBe("Fine. I am MKMN AI.");
  });

  it("an unfinished tail is flushed at the done, and a topic mention is never touched", () => {
    const g = new IdentityEventGuard("t");
    let answer = "";
    const feed = (evs: ChatEvent[]) => { for (const ev of evs) if (ev.type === "answer" || ev.type === "retract") answer = withAnswer(answer, ev); };
    feed(g.event({ id: "t", type: "answer", text: "Qwen3 runs well. I am Qw" }));
    feed(g.event({ id: "t", type: "answer", text: "en, made by Alibaba" }));
    feed(g.event({ id: "t", type: "done", stats: { ttftSec: 0.1, tokPerSec: 10, tokens: 3, totalSec: 1 } }));
    expect(answer).toBe("Qwen3 runs well. I am MKMN AI"); // the topic keeps its name, the self-claim does not
  });
});

describe("the app's own names", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mkmn-identity-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no exported file's metadata contains a forbidden name, and the author is MKMN AI", async () => {
    for (const kind of ["docx", "xlsx", "pptx"] as const) {
      const body = kind === "docx" ? "# Report\n\nText." : kind === "xlsx" ? "## Sheet\n\n| a | b |\n| 1 | 2 |" : "Theme: mkmn\n\n---\n\n# Slide one\n\nText";
      const bytes = await buildOffice(kind, body);
      const files = await readZip(bytes);
      const core = files["docProps/core.xml"];
      expect(core, `${kind}: core properties`).toBeTruthy();
      const text = new TextDecoder().decode(core!);
      expect(text).toContain(`<dc:creator>${ASSISTANT_NAME}</dc:creator>`);
      const app = new TextDecoder().decode(files["docProps/app.xml"]!);
      expect(app).toContain(`<Application>${ASSISTANT_NAME}</Application>`);
      for (const name of FORBIDDEN) {
        for (const [part, content] of Object.entries(files)) {
          expect(new TextDecoder().decode(content), `${kind} part ${part} names ${name}`).not.toContain(name);
        }
      }
    }
  });

  it("the renderer's user-facing strings find the old product name nowhere", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
      });
    const offenders: string[] = [];
    for (const f of walk(path.join(process.cwd(), "src", "renderer"))) {
      const text = readFileSync(f, "utf8");
      // Technical model names on the Models, Benchmark and Developer screens are allowed;
      // the old product name as a present-tense self-name is not.
      if (text.includes("Open NPU")) offenders.push(path.basename(f));
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The real runs on the smallest chat model answered plain knowledge questions
 * ("what is the overdue fine per day?", "من شركة النظافة؟") with the self-introduction
 * VERBATIM — 13 of 39 knowledge answers in an earlier build, 7 of 24 in the reduced pass,
 * and whole longconv answers too. The always-on identity block sat first in every
 * system prompt carrying a quoted ready-made answer, and a small model repeats quoted
 * sentences. The block must carry the name and the rules only — no quoted sentence for
 * a model to copy. The canned answer exists only where the guard writes it (an unnamed
 * self-description rewritten), never as an example to imitate.
 */
describe("no quoted ready-made answer in the always-on identity block", () => {
  const quotedOf = (s: string) => [...s.matchAll(/"([^"\n]+)"/g)].map((m) => m[1]).filter((q) => q.split(/\s+/).length >= 5);

  it("the identity block itself carries no quoted sentence a small model could copy as its answer", () => {
    expect(quotedOf(IDENTITY_INSTRUCTIONS)).toEqual([]);
  });

  it("a model that answers with the first quoted sentence of its system prompt does not answer a knowledge question with the self-introduction", () => {
    const sys = buildSystemPrompt({
      project: { id: "p1", name: "Handbook", description: "", instructions: "", files: [{ id: "f1", name: "handbook.txt", content: "The overdue fine per day is 200 dinars. The reading room has 100 seats." }] },
      knowledgeChars: 4000, artifacts: true, fileKind: null, contextTokens: 8192,
    } as Parameters<typeof buildSystemPrompt>[0]);
    const first = quotedOf(sys)[0] ?? "";
    expect(first).not.toBe(`I am ${ASSISTANT_NAME}, your assistant on this PC.`);
  });
});
