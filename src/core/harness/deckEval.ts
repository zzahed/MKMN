/**
 * The deck eval: the presentation pipeline run end to end against scripted model
 * personas, each one the habit of a small local model that made decks look
 * unfinished — the same line on every slide, one-bullet slides, a plan whose
 * topics repeat, a slide the vision check finds half empty. A persona answers
 * from the request it is sent (it follows the feedback the app gives, as a
 * model does), never from a network. The finished deck is scored by the deck
 * rubric (src/core/deckQuality.ts) and must reach QUALITY_BAR.
 *
 * A persona is not a dataset of answers to freeze: it is the model's behaviour,
 * so it lives in code next to the evaluator that drives it.
 */
import type { ChatEvent, ChatMessage, ChatStats } from "../../shared/types";
import { makeDeck, type DeckOptions } from "../deckBuild";
import { deckQuality } from "../deckQuality";
import { slidesOf } from "../slides";
import { QUALITY_BAR } from "./quality";
import type { CaseResult } from "./evals";

interface Asked { n: number; role: string; topic: string; prompt: string; attempt: number }

export interface DeckScenario {
  id: string;
  description: string;
  request: string;
  plan: string;
  /** The planner asked again with the problems of its first plan. */
  replan?: string;
  write: (a: Asked) => string;
  /** The fixer's reply; absent: the fixer resends the slide as it was. */
  fix?: (prompt: string) => string;
  /** The vision check's verdict for slide n (1-based), given how many of the persona's facts the drawing shows; absent: no renderer, no vision. */
  vision?: (n: number, shownLines: number) => string;
}

const stats: ChatStats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };

// distinct facts, so a persona that does write new things writes lines that share no words
const FACTS = [
  "Panels convert sunlight directly", "Silicon cells free electrons", "Inverters supply household current", "Batteries store evening output",
  "Prices dropped ninety percent", "Rooftops cover residential needs", "Farms feed regional grids", "Output peaks around noon",
  "Clouds reduce yield moderately", "Recycling recovers glass frames", "Subsidies shorten payback", "Installers survey roof angles",
  "Warranties span twenty-five years", "Dust lowers efficiency slightly", "Trackers follow daily arcs", "Deserts host huge arrays",
];
let cursor = 0;
const fresh = (k: number) => Array.from({ length: k }, () => `- ${FACTS[cursor++ % FACTS.length]}`).join("\n");

const SLIDE = /Write slide (\d+) \((cover|content|closing)\): ([^\n]*?)\.\s/;
const PLAN_SOLAR = (topics: string[]) => ["Title: Solar Power", "Theme: clean", "Slide: cover | Solar Power | none", ...topics.map((t) => `Slide: content | ${t}`), "Slide: closing | Go solar | none"].join("\n");
const frame = (a: Asked) => (a.role === "cover" ? "# Solar Power\nEnergy from the sun" : "# Go solar this year\nAsk an installer for a quote");

export const DECK_SCENARIOS: DeckScenario[] = [
  {
    id: "repeater",
    description: "writes the same line on every slide until told it repeats",
    request: "make a 6 slide presentation about solar power",
    plan: PLAN_SOLAR(["How panels work | none", "Costs today | stats 90% cheaper; 25 years life", "Installing panels | flow Survey -> Fit -> Connect", "Limits | none"]),
    write: (a) => (a.role !== "content" ? frame(a) : /repeats slide/.test(a.prompt) ? `# ${a.topic}\n${fresh(3)}${/stats/.test(a.prompt) ? "\nStats: 90% | cheaper since 2010 ; 25y | panel life" : ""}${/diagram/i.test(a.prompt) ? "\nFlow: Survey -> Fit -> Connect" : ""}` : `# ${a.topic}\n- Solar power is clean and renewable\n- Solar power is clean energy for homes\n- Panels sit on roofs`),
  },
  {
    id: "thin",
    description: "writes one bullet per slide until told the slide is too thin",
    request: "make a 5 slide presentation about solar power",
    plan: PLAN_SOLAR(["How panels work | none", "Costs today | columns Upfront; Running", "Limits | none"]),
    write: (a) => (a.role !== "content" ? frame(a) : /too thin/.test(a.prompt) ? `# ${a.topic}\n${fresh(3)}` : /columns/i.test(a.prompt) ? `# ${a.topic}\nColumn: Upfront | Panels and fitting ; Inverter purchase\nColumn: Running | Cleaning twice yearly ; Inverter replacement` : `# ${a.topic}\n- Good`),
  },
  {
    id: "duplicate-plan",
    description: "plans two slides on the same topic and a deck of bullets, then corrects the plan when told",
    request: "make a 7 slide presentation about solar power",
    plan: PLAN_SOLAR(["Benefits of solar | none", "Benefits of solar power | none", "How panels work | none", "Costs | none", "Limits | none"]),
    replan: PLAN_SOLAR(["Benefits of solar | none", "How panels work | flow Light -> Cell -> Current", "Costs | stats 90% cheaper; 25 years life", "Limits | none", "Where it works best | none"]),
    write: (a) => (a.role !== "content" ? frame(a) : `# ${a.topic.replace(/^Benefits.*/, "Solar cuts bills and emissions")}\n${fresh(3)}${/Add a diagram/.test(a.prompt) ? "\nFlow: Light -> Cell -> Current" : ""}${/Add the figures/.test(a.prompt) ? "\nStats: 90% | cheaper since 2010 ; 25y | panel life" : ""}`),
  },
  {
    id: "empty-area",
    description: "a slide the vision check finds half empty; the fixer adds when asked to fill, and only cuts when asked to shorten",
    request: "make a 4 slide presentation about solar power",
    plan: PLAN_SOLAR(["How panels work | none", "Limits | none"]),
    write: (a) => (a.role !== "content" ? frame(a) : `# ${a.topic}\n${fresh(3)}`),
    fix: (prompt) => {
      const cur = /Your previous try:\n([\s\S]*?)\n\nIt breaks these rules/.exec(prompt)?.[1] ?? "# Slide\n- x";
      const lines = cur.split("\n").filter((l) => !/^Layout:/.test(l));
      return /Fill the slide/.test(prompt) ? `${lines.join("\n")}\n${fresh(2)}` : lines.slice(0, 2).join("\n");
    },
    vision: (n, shown) => (n === 2 && shown < 5 ? "PROBLEM: a big empty area under the bullets" : "OK"),
  },
];

/** Run one scenario through makeDeck and score the deck it made. */
export async function evaluateDeckScenario(s: DeckScenario): Promise<CaseResult> {
  cursor = 0;
  const tries = new Map<number, number>();
  const stream: DeckOptions["stream"] = async function* (sid: string, messages: ChatMessage[]): AsyncGenerator<ChatEvent> {
    const prompt = String(messages[messages.length - 1]?.content ?? ""); // what the app asked this time, not the standing instructions
    let text: string;
    if (sid.endsWith("deckplan")) text = s.plan;
    else if (sid.endsWith("deckplan:1")) text = s.replan ?? s.plan;
    else if (sid.endsWith("deckexplain")) text = "I made the presentation.";
    else if (/:fix\d+:/.test(sid)) text = s.fix ? s.fix(prompt) : (/Your previous try:\n([\s\S]*?)\n\nIt breaks/.exec(prompt)?.[1] ?? "");
    else if (/:slide\d+:/.test(sid)) {
      const m = SLIDE.exec(prompt);
      const n = Number(m?.[1] ?? 0);
      const attempt = tries.get(n) ?? 0;
      tries.set(n, attempt + 1);
      text = s.write({ n, role: m?.[2] ?? "content", topic: (m?.[3] ?? "Topic").trim(), prompt, attempt });
    } else text = "{}"; // the brief and the look: no usable answer, the defaults stand
    yield { id: "eval", type: "answer", text };
    yield { id: "eval", type: "done", stats };
  };
  // the renderer draws one slide: its number and how many of the persona's facts it shows, read back by the vision persona
  const vision = s.vision;
  const opts: DeckOptions = { id: "eval", messages: [{ role: "user", content: s.request }], stream };
  if (vision) {
    opts.render = async (html) => {
      const n = Number(/data-i="(\d+)"/.exec(html)?.[1] ?? -1) + 1;
      const shown = FACTS.filter((f) => html.includes(f)).length;
      return { shot: `data:text/plain;base64,${Buffer.from(JSON.stringify({ n, shown })).toString("base64")}`, problems: [] };
    };
    opts.lookAt = async (shot) => {
      const { n, shown } = JSON.parse(Buffer.from(shot.split(",")[1], "base64").toString()) as { n: number; shown: number };
      return vision(n, shown);
    };
  }
  const gen = makeDeck(opts);
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  const text = r.value.handled ? r.value.text : "";
  const src = /<artifact type="pptx"[^>]*>\n([\s\S]*?)\n<\/artifact>/.exec(text)?.[1] ?? "";
  const q = deckQuality(slidesOf(src));
  const pass = !!src && q.score >= QUALITY_BAR;
  return { id: s.id, pass, metrics: { quality: q.score, slides: slidesOf(src).length }, detail: pass ? undefined : `score ${q.score}: ${q.failed.map((f) => `${f.id} (${f.note})`).join("; ") || "no deck"}` };
}
