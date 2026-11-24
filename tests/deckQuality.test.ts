// The quality of a generated deck: the defects a small local model's deck showed
// (a fix told to "make it shorter" for an empty slide and accepted unseen, the
// cover rewritten into a content slide, slides repeating each other, one-bullet
// slides, duplicate topics in the plan) and the harness rubric that scores them.
import { describe, expect, it } from "vitest";
import { contentProblems, fixInstruction, makeDeck, planProblems, saidBefore, type DeckPlan } from "../src/core/deckBuild";
import { deckQuality } from "../src/core/deckQuality";
import { scoreRubric, type Rubric } from "../src/core/harness/quality";
import { DECK_SCENARIOS, evaluateDeckScenario } from "../src/core/harness/deckEval";
import type { Slide } from "../src/core/slides";
import type { ChatEvent, ChatMessage, ChatStats } from "../src/shared/types";

const stats: ChatStats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };
const slide = (title: string, ...lines: string[]): Slide => ({ title, lines: lines.map((text) => ({ text, level: 0, bullet: true })), table: null, notes: "" });

async function drive(gen: AsyncGenerator<ChatEvent, unknown>) {
  const events: ChatEvent[] = [];
  for (;;) { const n = await gen.next(); if (n.done) return { r: n.value as { handled: boolean; text?: string }, events }; events.push(n.value); }
}

describe("the plan is checked before any slide is written", () => {
  const plan = (topics: string[], visuals?: string[]): DeckPlan => ({ title: "Solar", theme: "clean", slides: topics.map((topic, i) => ({ role: i === 0 ? "cover" : i === topics.length - 1 ? "closing" : "content", topic, visual: (visuals?.[i] ?? "none") as never, hint: "" })) });
  it("names topics that say the same thing", () => {
    expect(planProblems(plan(["Solar", "Benefits of solar", "Benefits of solar energy", "How panels work", "End"])).join(" ")).toMatch(/same/i);
    expect(planProblems(plan(["Solar", "What it is", "Benefits", "How panels work", "Costs", "End"]))).toEqual([]);
  });
  it("names a long deck of bullets only", () => {
    expect(planProblems(plan(["S", "A", "B", "C", "D", "E", "End"])).join(" ")).toMatch(/visual/i);
    expect(planProblems(plan(["S", "A", "B", "C", "D", "E", "End"], ["none", "none", "flow", "none", "columns", "none", "none"]))).toEqual([]);
  });
  it("the planner is asked once more with the problems, and the better plan is kept", async () => {
    const asked: string[] = [];
    const stream = async function* (sid: string, ms: ChatMessage[]): AsyncGenerator<ChatEvent> {
      if (sid.includes("deckplan")) asked.push(String(ms[ms.length - 1].content));
      const t = sid.endsWith("deckplan") ? "Title: Solar\nTheme: clean\nSlide: cover | Solar | none\nSlide: content | Benefits of solar | none\nSlide: content | Benefits of solar energy | none\nSlide: closing | End | none"
        : sid.endsWith("deckplan:1") ? "Title: Solar\nTheme: clean\nSlide: cover | Solar | none\nSlide: content | Benefits of solar | none\nSlide: content | How panels work | flow Light -> Cell -> Current\nSlide: closing | End | none"
        : sid.endsWith("deckexplain") ? "Done." : /slide/.test(sid) ? "# Something true\n- one fact here\n- another fact here\n- a third fact" : "{}";
      yield { id: "x", type: "answer", text: t }; yield { id: "x", type: "done", stats };
    };
    const { r } = await drive(makeDeck({ id: "x", messages: [{ role: "user", content: "make a 4 slide presentation about solar" }], stream }));
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatch(/same/i);
    expect(r.text).toContain("Flow: Light -> Cell -> Current");
  });
});

describe("each slide is written knowing the ones before it", () => {
  it("the writer is told what earlier slides already said", () => {
    const said = saidBefore([slide("Solar", "Power from the sun"), slide("Benefits", "Solar is clean and renewable", "Cuts bills")]);
    expect(said).toContain("Solar is clean and renewable");
    expect(said).toContain("Cuts bills");
  });
  it("a thin content slide is asked again, a full one is not", () => {
    expect(contentProblems(slide("Benefits", "Clean"), "none", []).join(" ")).toMatch(/thin/i);
    expect(contentProblems(slide("Benefits", "Clean energy", "Lower bills", "Fewer emissions"), "none", [])).toEqual([]);
    // a slide carried by its visual needs no bullets
    expect(contentProblems({ ...slide("Steps"), flow: ["a", "b", "c"] }, "flow", [])).toEqual([]);
  });
  it("a line that repeats an earlier slide is named", () => {
    const earlier = [slide("Benefits", "Solar energy is clean and renewable")];
    expect(contentProblems(slide("Why solar", "Solar energy is clean and renewable", "Panels last 25 years", "Costs fell 90%"), "none", earlier).join(" ")).toMatch(/repeats/i);
  });
});

describe("the fix goes the way the problem asks", () => {
  it("an empty area asks for more, an overflow asks for less", () => {
    expect(fixInstruction(["a big empty area below two short lines"])).toMatch(/add/i);
    expect(fixInstruction(["text cut off at the bottom"])).toMatch(/shorter/i);
  });
});

describe("a fix flagged by the vision check is looked at again", () => {
  const PLAN = "Title: Solar Energy\nTheme: clean\nSlide: cover | Solar Energy | none\nSlide: content | What is solar | none\nSlide: content | How panels work | none\nSlide: closing | Conclusion | none";
  const run = async (fixReply: string, verdict: (shot: string, n: number) => string) => {
    const prompts: Record<string, string> = {};
    let looks = 0;
    const stream = async function* (sid: string, ms: ChatMessage[]): AsyncGenerator<ChatEvent> {
      prompts[sid] = ms.map((m) => String(m.content)).join("\n");
      const t = sid.endsWith("deckplan") ? PLAN : sid.endsWith("deckexplain") ? "Done." : /fix/.test(sid) ? fixReply
        : /slide0/.test(sid) ? "# Solar Energy\nPower from the sun" : /slide1/.test(sid) ? "# What is solar\n- Light turned into power\n- Two main kinds\n- Used since 1950s"
        : /slide2/.test(sid) ? "# How panels work\n- Cells free electrons\n- Inverter makes AC\n- Grid takes the surplus" : /slide3/.test(sid) ? "# Go solar\nStart with a quote" : "{}";
      yield { id: "x", type: "answer", text: t }; yield { id: "x", type: "done", stats };
    };
    let shots = 0;
    const { r, events } = await drive(makeDeck({ id: "x", messages: [{ role: "user", content: "make a 4 slide presentation about solar" }], stream,
      render: async (html) => ({ shot: `data:image/jpeg;base64,${Buffer.from(String(shots++) + (/Clean/.test(html) ? "C" : "")).toString("base64")}`, problems: [] }),
      lookAt: async (shot) => { looks++; return verdict(Buffer.from(shot.split(",")[1], "base64").toString(), looks); } }));
    return { r, events, prompts, looks };
  };
  it("the fixer is asked to fill an empty slide, and a fix the vision still flags is undone: the cover keeps its title and layout", async () => {
    // the vision flags only the cover; the model's "fix" is an unrelated slide, which the second look still flags
    const { r, prompts, looks } = await run("# Benefits\n- Clean", (shot) => (shot.startsWith("0") || shot.includes("C") ? "PROBLEM: a big empty area below two short lines" : "OK"));
    const fix = Object.keys(prompts).find((k) => k.includes(":fix0"))!;
    expect(prompts[fix]).toMatch(/add/i);
    expect(prompts[fix]).not.toMatch(/Make the slide shorter/);
    expect(looks).toBeGreaterThan(4); // the fix was looked at again
    expect(r.text).toContain("# Solar Energy\nLayout: cover\nPower from the sun"); // the rejected fix was undone
    expect(r.text).not.toContain("# Benefits");
    expect(r.text).not.toContain("Clean");
  });
  it("a fix the second look approves is kept", async () => {
    const { r } = await run("# What is solar\n- Light turned into power\n- Two main kinds\n- Used since 1950s\n- Powers 4% of the world", (shot, n) => (shot.startsWith("1") && n === 2 ? "PROBLEM: a big empty area on the right" : "OK"));
    expect(r.text).toContain("Powers 4% of the world");
  });
});

describe("the quality harness", () => {
  it("a rubric scores by weight and names what failed", () => {
    const rubric: Rubric<number> = { name: "n", checks: [{ id: "pos", weight: 3, test: (n) => n > 0 || "not positive" }, { id: "even", weight: 1, test: (n) => n % 2 === 0 || "odd" }] };
    expect(scoreRubric(rubric, 2)).toMatchObject({ score: 1, failed: [] });
    const odd = scoreRubric(rubric, 3);
    expect(odd.score).toBe(0.75);
    expect(odd.failed).toEqual([{ id: "even", note: "odd" }]);
  });
  it("the deck rubric scores a weak deck low and a good one high", () => {
    const weak = Array.from({ length: 6 }, () => slide("Benefits", "Clean"));
    weak[0] = { ...weak[0], layout: "cover" };
    const good: Slide[] = [
      { ...slide("Solar Energy", "Power from the sun"), layout: "cover" },
      slide("Sunlight becomes power", "Cells free electrons", "Inverters make AC", "Surplus feeds the grid"),
      { ...slide("Costs fell fast"), stats: [{ value: "90%", label: "panel price drop since 2010" }, { value: "25y", label: "typical panel life" }] },
      { ...slide("Install in three steps"), flow: ["Survey the roof", "Fit the panels", "Connect the grid"] },
      slide("Limits to plan for", "Output drops at night", "Storage adds cost", "Roofs face the wrong way"),
      { ...slide("Go solar this year", "Ask for a quote"), layout: "closing" },
    ];
    const w = deckQuality(weak), g = deckQuality(good);
    expect(w.score).toBeLessThan(0.6);
    expect(w.failed.map((f) => f.id)).toEqual(expect.arrayContaining(["distinctTitles", "noRepeats", "density", "cover"]));
    expect(g.score).toBeGreaterThanOrEqual(0.9);
  });
  it("the deck reports its quality score with its metrics", async () => {
    const stream = async function* (sid: string): AsyncGenerator<ChatEvent> {
      const t = sid.endsWith("deckplan") ? "Title: Bees\nTheme: forest\nSlide: cover | Bees | none\nSlide: content | Why they matter | none\nSlide: closing | Protect them | none" : sid.endsWith("deckexplain") ? "Done." : /slide0/.test(sid) ? "# Bees\nTiny workers" : /slide1/.test(sid) ? "# Bees feed us\n- A third of crops need them\n- Colonies hold 50,000 bees\n- Honey keeps for years" : /slide2/.test(sid) ? "# Plant flowers\nEvery garden helps" : "{}";
      yield { id: "x", type: "answer", text: t }; yield { id: "x", type: "done", stats };
    };
    const { events } = await drive(makeDeck({ id: "x", messages: [{ role: "user", content: "make a 3 slide presentation about bees" }], stream }));
    const last = events.filter((e) => e.type === "build").pop();
    expect(last?.type === "build" && last.build.deckMetrics?.quality).toBeGreaterThan(0.8);
  });
});

describe("the deck eval", () => {
  it("every scripted model persona yields a deck at or above the bar", async () => {
    for (const s of DECK_SCENARIOS) {
      const res = await evaluateDeckScenario(s);
      expect(res.pass, `${s.id}: ${res.detail ?? ""}`).toBe(true);
    }
  });
});
