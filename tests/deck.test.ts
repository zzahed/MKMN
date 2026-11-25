import { describe, expect, it } from "vitest";
import { makeDeck, parsePlan, slideCountOf, wantsDeck, chartIsUsable, parseSlideReply } from "../src/core/deckBuild";
import { LIMITS, deckHtml, layoutAll, slideProblems, slidesOf, themeOf, trimSlide } from "../src/core/slides";
import type { ChatEvent, ChatStats } from "../src/shared/types";

const stats: ChatStats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };

describe("asking for a deck", () => {
  it("is recognised, and only for a new deck", () => {
    expect(wantsDeck("Make me a presentation about volcanoes", false)).toBe(true);
    expect(wantsDeck("make me a powerpoint of 8 slides about bees", false)).toBe(true);
    expect(wantsDeck("Make me a presentation about volcanoes", true)).toBe(false);
    expect(wantsDeck("summarize this presentation for me", false)).toBe(false);
    expect(wantsDeck("what is a slide deck?", false)).toBe(false);
    // asked as a noun phrase, without a verb: seen with "one slide presentation for the upstream…", which went to the file builder
    expect(wantsDeck("one slide presentation for the upstream business for the Q3 interim results", false)).toBe(true);
    expect(wantsDeck("A 5-slide deck on our Q3 results", false)).toBe(true);
    expect(wantsDeck("presentation about volcanoes", false)).toBe(true);
    expect(wantsDeck("my presentation for tomorrow is too long", false)).toBe(false);
    expect(wantsDeck("the presentation of the data is confusing", false)).toBe(false);
    expect(wantsDeck("slides for the meeting?", false)).toBe(false);
    expect(slideCountOf("a 10 slides deck")).toBe(10);
    expect(slideCountOf("a slideshow of 8 slides")).toBe(8);
    expect(slideCountOf("a deck")).toBeNull();
  });
});

describe("the plan", () => {
  const reply = "Title: Volcanoes\nTheme: sunrise\nSlide: cover | Volcanoes | none\nSlide: content | How they form | flow Magma rises -> Pressure builds -> Eruption\nSlide: content | Famous ones | image Mount Fuji volcano\nSlide: content | Deadliest | chart bar deaths\nSlide: closing | Respect them | none";
  it("is read, with the visuals the plan allows", () => {
    const p = parsePlan(reply, "volcanoes", null, true);
    expect(p.theme).toBe("sunrise");
    expect(p.slides.map((s) => s.visual)).toEqual(["none", "flow", "image", "chart", "none"]);
    expect(p.slides[0].role).toBe("cover");
    expect(p.slides[4].role).toBe("closing");
    expect(parsePlan(reply, "volcanoes", null, false).slides[2].visual).toBe("none");
  });
  it("falls back to an outline when the reply is garbage, and respects a requested count", () => {
    const p = parsePlan("blah", "bees", 5, false);
    expect(p.slides).toHaveLength(5);
    expect(p.slides[0].role).toBe("cover");
    expect(parsePlan(reply, "x", 3, true).slides).toHaveLength(3);
  });
});

describe("limits", () => {
  it("are checked and enforced", () => {
    const s = parseSlideReply("```\n# A very long title that goes on and on forever and ever\n- one\n- two\n- three\n- four\n- five\n- six\n- seven\n```")!;
    expect(slideProblems(s).length).toBeGreaterThan(0);
    const t = trimSlide(s);
    expect(slideProblems(t)).toEqual([]);
    expect(t.lines.length).toBeLessThanOrEqual(LIMITS.bullets);
  });
  it("a chart needs numbers", () => {
    const ok = slidesOf("# T\nChart: bar\n| a | b |\n|---|---|\n| x | 1 |\n| y | 2 |")[0];
    const bad = slidesOf("# T\nChart: bar\n| a | b |\n|---|---|\n| x | many |\n| y | few |")[0];
    expect(chartIsUsable(ok)).toBe(true);
    expect(chartIsUsable(bad)).toBe(false);
  });
});

describe("making a deck", () => {
  const fake = (replies: (sid: string) => string) => async function* (sid: string): AsyncGenerator<ChatEvent> {
    yield { id: "x", type: "answer", text: replies(sid) };
    yield { id: "x", type: "done", stats };
  };
  it("plans, writes within limits, checks every slide, fixes one, and returns a pptx artifact", async () => {
    const calls: string[] = [];
    let renders = 0;
    const gen = makeDeck({
      id: "x", messages: [{ role: "user", content: "Make a 4 slide presentation about bees" }],
      stream: fake((sid) => {
        calls.push(sid);
        if (sid.endsWith("deckplan")) return "Title: Bees\nTheme: forest\nSlide: cover | Bees | none\nSlide: content | Why they matter | flow Flowers -> Pollen -> Honey\nSlide: content | Facts | none\nSlide: closing | Protect them | none";
        if (sid.endsWith("deckexplain")) return "I made a 4 slide deck.";
        if (/slide0/.test(sid)) return "# Bees\nBuzzing facts";
        if (/slide1:0/.test(sid)) return "# Why they matter\n- one\n- two\n- three\n- four\n- five\n- six\n- seven\n- eight";
        if (/slide1:1/.test(sid)) return "# Why they matter\n- Pollination\n- Honey\nFlow: Flowers -> Pollen -> Honey";
        if (/fix/.test(sid)) return "# Facts\n- Short";
        if (/slide2/.test(sid)) return "# Facts\n- 20000 species\n- Live in colonies";
        return "# Protect them\nPlant flowers";
      }),
      render: async (html) => { renders++; expect(html).toContain("slide"); return { shot: "data:image/jpeg;base64,AAAA", problems: /Facts/.test(html) && renders < 6 && !/Short/.test(html) ? ["text cut off"] : [] }; }
    });
    const events: ChatEvent[] = [];
    let r;
    for (;;) { const n = await gen.next(); if (n.done) { r = n.value; break; } events.push(n.value); }
    expect(r.handled).toBe(true);
    if (!r.handled) return;
    expect(r.text).toContain('<artifact type="pptx" title="Bees">');
    expect(r.text).toContain("Theme: forest");
    expect(r.text).toContain("Flow: Flowers -> Pollen -> Honey");
    expect(r.text).not.toContain("- eight");
    expect(themeOf(r.text).id).toBe("forest");
    expect(layoutAll(r.text.replace(/<\/?artifact[^>]*>/g, "")).slides).toHaveLength(4);
    expect(calls.some((c) => /fix2/.test(c))).toBe(true);
    const builds = events.filter((e) => e.type === "build");
    const last = builds[builds.length - 1];
    expect(last.type === "build" && last.build.status).toBe("done");
    expect(last.type === "build" && last.build.steps).toHaveLength(4);
    expect(last.type === "build" && last.build.steps[2].stages!.map((s) => s.id)).toEqual(["write", "shot", "fix"]);
  });
  it("adds a Wikimedia picture, and goes on without when none loads", async () => {
    const gen = makeDeck({
      id: "x", messages: [{ role: "user", content: "make a deck about Fuji" }],
      stream: fake((sid) => sid.endsWith("deckplan") ? "Title: Fuji\nTheme: clean\nSlide: cover | Fuji | none\nSlide: content | The mountain | image Mount Fuji\nSlide: content | The lake | image Lake Kawaguchi\nSlide: closing | End | none" : sid.endsWith("deckexplain") ? "Done." : /slide0/.test(sid) ? "# Fuji\nJapan" : /slide3/.test(sid) ? "# End\nBye" : "# Topic\n- A\n- B"),
      candidates: async (q) => (/Fuji/.test(q) ? [{ file: "Fuji.jpg", description: "Mount Fuji", license: "CC0" }] : [{ file: "Broken.jpg", description: "x", license: "CC0" }]),
      picture: async (f) => (f === "Fuji.jpg" ? { dataUrl: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", w: 10, h: 10, credit: "Photo: me" } : null)
    });
    let r;
    for (;;) { const n = await gen.next(); if (n.done) { r = n.value; break; } }
    expect(r.handled && r.text).toContain("![Mount Fuji](wikimedia:Fuji.jpg)");
    expect(r.handled && r.text).not.toContain("Broken.jpg");
    expect(deckHtml("# A\n![c](wikimedia:Fuji.jpg)", { "Fuji.jpg": { dataUrl: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", w: 10, h: 10, credit: "Photo: me" } })).toContain("<img");
  });

  it("draws a diagram through the window and keeps the slide's text when it cannot be drawn", async () => {
    const stream = fake((sid) => sid.endsWith("deckplan") ? "Title: Eruptions\nTheme: midnight\nSlide: cover | Eruptions | none\nSlide: content | History | diagram timeline Big eruptions\nSlide: closing | End | none" : sid.endsWith("deckexplain") ? "Done." : /slide0/.test(sid) ? "# Eruptions\nA history" : /slide2/.test(sid) ? "# End\nBye" : "# History\n- Dates matter\n```mermaid\ntimeline\n  79 : Vesuvius\n  1883 : Krakatoa\n```");
    const run = async (draw: boolean) => {
      const asked: string[] = [];
      const gen = makeDeck({ id: "x", messages: [{ role: "user", content: "make a deck about eruptions" }], stream, figure: async (lang, raw) => { asked.push(`${lang}:${raw.split("\n")[0]}`); return draw ? { dataUrl: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", w: 800, h: 400, credit: "" } : null; } });
      let r;
      for (;;) { const n = await gen.next(); if (n.done) { r = n.value; break; } }
      return { r, asked };
    };
    const ok = await run(true);
    expect(ok.asked).toEqual(["mermaid:timeline"]);
    expect(ok.r.handled && ok.r.text).toContain("```mermaid\ntimeline");
    const failed = await run(false);
    expect(failed.r.handled && failed.r.text).not.toContain("mermaid");
    expect(failed.r.handled && failed.r.text).toContain("Dates matter");
  });
});

describe("a deck built where the host cannot draw slides", () => {
  const stats: ChatStats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };
  // 6 lines of 14 long words each: within the plan limits (so the writer is not retried) but more
  // text than the slide can hold, so the app's own layout measure flags it
  const longLine = `- ${Array.from({ length: 14 }, () => "w".repeat(30)).join(" ")}`;
  const TIGHT = `# Facts\n${Array.from({ length: 6 }, () => longLine).join("\n")}`;
  const PLAN = "Title: Bees\nTheme: forest\nSlide: cover | Bees | none\nSlide: content | Facts | none\nSlide: closing | End | none";
  const fake = (replies: (sid: string) => string, onExplain?: (prompt: string) => void) => async function* (sid: string, messages: ChatMessage[]): AsyncGenerator<ChatEvent> {
    if (sid.endsWith("deckexplain") && onExplain) onExplain(messages.map((m) => String(m.content)).join("\n"));
    yield { id: "x", type: "answer", text: replies(sid) };
    yield { id: "x", type: "done", stats };
  };
  const build = (sid: string) =>
    sid.endsWith("deckplan") ? PLAN : sid.endsWith("deckexplain") ? "Done." : /fix/.test(sid) ? "# Facts\n- Short and clear" : /slide1/.test(sid) ? TIGHT : /slide0/.test(sid) ? "# Bees\nBuzzing facts" : "# End\nPlant flowers";
  const run = async (extra: object, onExplain?: (prompt: string) => void, replies: (sid: string) => string = build) => {
    const events: ChatEvent[] = [];
    const gen = makeDeck({ id: "x", messages: [{ role: "user", content: "make a deck about bees" }], stream: fake(replies, onExplain), ...extra });
    let r;
    for (;;) { const n = await gen.next(); if (n.done) { r = n.value; break; } events.push(n.value); }
    const builds = events.filter((e) => e.type === "build");
    const metrics = builds.map((e) => (e.type === "build" ? e.build.deckMetrics : null)).filter(Boolean);
    const lastBuild = builds[builds.length - 1];
    // the stages of one slide, as the LAST build event holds them (each event repeats the stages so far)
    const notes = (at: number) => ((lastBuild?.type === "build" ? lastBuild.build.steps[at]?.stages : []) ?? []).map((g) => ({ id: g.id, status: g.status, note: g.note ?? "" }));
    return { r, events, renders: metrics.map((m) => m!.renders), last: metrics[metrics.length - 1], notes };
  };

  it("the tight slide is fixed by the layout measure alone: no screenshot stage, no render counted, nothing claims it was drawn", async () => {
    let report = "";
    const full = await run({}, (p) => { report = p; });
    expect(full.r.handled).toBe(true);
    if (!full.r.handled) return;
    expect(full.renders.every((n) => n === 0)).toBe(true); // no render pass is ever counted
    expect(full.notes(1).map((g) => g.id)).toEqual(["write", "layout", "fix"]); // the slide was measured and fixed, never "looked at"
    expect(full.notes(1).some((g) => g.note === "looks fine")).toBe(false);
    expect(full.notes(1).some((g) => g.note.includes("too long"))).toBe(true); // the overflow is what the fix was asked for
    expect(full.notes(0).some((g) => g.note === "layout fits, not drawn")).toBe(true); // the others: measured, not drawn
    expect(full.r.text).toContain("- Short and clear"); // the fix landed
    expect(layoutAll(full.r.text.replace(/<\/?artifact[^>]*>/g, "")).slides).toHaveLength(3); // the deck is still whole
    // the summary says what really happened: no render passes claimed, the layout measure named as the only judge
    expect(report).not.toContain("Render passes");
    expect(report).toContain("layout measure only, not drawn");
  });

  it("low power does the same, with one fix round", async () => {
    let report = "";
    const low = await run({ lowPower: true }, (p) => { report = p; });
    expect(low.r.handled).toBe(true);
    if (!low.r.handled) return;
    expect(low.renders.every((n) => n === 0)).toBe(true);
    expect(low.notes(1).map((g) => g.id)).toEqual(["write", "layout", "fix"]);
    expect(low.notes(1).some((g) => g.note === "looks fine")).toBe(false);
    expect(low.r.text).toContain("- Short and clear");
    expect(report).not.toContain("Render passes");
    expect(report).toContain("checked by the app's own layout measure only");
    expect(report).toContain("Power mode: low");
  });

  it("with a renderer that reports nothing, the layout overflow is still fed to the fix loop", async () => {
    let renders = 0;
    let report = "";
    const withRender = await run({ render: async () => { renders++; return { shot: "data:image/jpeg;base64,AAAA", problems: [] }; } }, (p) => { report = p; });
    expect(withRender.r.handled).toBe(true);
    if (!withRender.r.handled) return;
    expect(renders).toBeGreaterThanOrEqual(4); // every slide drawn, the tight one drawn again for its fix
    expect(withRender.last?.renders).toBe(renders); // the count is the honest one
    expect(withRender.notes(1).some((g) => g.id === "fix")).toBe(true); // the tight slide was fixed anyway
    expect(withRender.r.text).toContain("- Short and clear");
    expect(report).toContain(`Render passes: ${renders}`);
  });

  it("a fix that does not shrink the overflow is undone, and the slide keeps its tightness", async () => {
    const worse = `- ${Array.from({ length: 14 }, () => "w".repeat(40)).join(" ")}`;
    let report = "";
    const noBetter = await run({}, (p) => { report = p; }, (sid) => (/fix/.test(sid) ? `# Facts\n${Array.from({ length: 6 }, () => worse).join("\n")}` : build(sid)));
    expect(noBetter.r.handled).toBe(true);
    if (!noBetter.r.handled) return;
    expect(noBetter.notes(1).some((g) => g.id === "fix" && g.status === "skipped")).toBe(true); // made it worse, undone
    expect(noBetter.r.text).toContain("w".repeat(30)); // the original tight slide is kept
    expect(report).toContain("Slides still tight: 2"); // and the summary says it is still tight
  });
});

describe("slide text from a model", () => {
  it("drops a 'Slide 4:' label the model put in front of the title", () => {
    expect(parseSlideReply("# Slide 4: Expansion of Trade Agreements\n- ASEAN 1995")?.title).toBe("Expansion of Trade Agreements");
    expect(parseSlideReply("# Slide 12 - Conclusion\n- one")?.title).toBe("Conclusion");
  });
  it("reads a long source text whole, in the planner and the writer", async () => {
    const { deckPlannerPrompt, hasSource } = await import("../src/core/deckBuild");
    const text = `${"Fact about trade. ".repeat(150)}FINAL-CONCLUSION`;
    expect(hasSource(text)).toBe(true);
    expect(deckPlannerPrompt(text, null, false)).toContain("FINAL-CONCLUSION");
  });
});

describe("richer slides", () => {
  it("reads and writes stats and columns, and lays them out with a bullet or alone", async () => {
    const { slidesOf, layoutSlide, THEMES } = await import("../src/core/slides");
    const { slideSource } = await import("../src/core/deckBuild");
    const [a, b] = slidesOf("# Key numbers\nStats: $930bn | Trade in 2025 ; 180% | of GDP ; 8% | Growth\n- Open economy\n\n---\n\n# Three pillars\nColumn: Institutions | WTO 2007 ; IMF member\nColumn: Trade | 17 FTAs ; CPTPP\nColumn: Capital | $27.6bn FDI ; Samsung 13%");
    expect(a.stats).toHaveLength(3);
    expect(b.columns).toHaveLength(3);
    expect(slidesOf(slideSource(a))[0].stats).toEqual(a.stats);
    expect(slidesOf(slideSource(b))[0].columns).toEqual(b.columns);
    const t = THEMES[0];
    const la = layoutSlide(a, t, { index: 1, count: 3, pics: {} });
    expect(la.above.filter((p) => p.k === "round")).toHaveLength(3);
    expect(la.body).toBeDefined();
    const lb = layoutSlide(b, t, { index: 2, count: 3, pics: {} });
    expect(lb.overflow).toEqual([]);
    expect(lb.above.filter((p) => p.k === "rect" && p.text).length).toBe(3);
  });
});

describe("slide look and text blocks", () => {
  it("reads Style, Callout and Quote, keeps the text readable on a dark background, and round-trips", async () => {
    const { slidesOf, layoutSlide, styledTheme, THEMES } = await import("../src/core/slides");
    const { slideSource } = await import("../src/core/deckBuild");
    const [a] = slidesOf('# Key message\nStyle: bg=navy accent=orange font=Georgia size=large\nCallout: Vietnam opened up and grew\nQuote: Trade is the engine | A minister\n- one');
    expect(a.style).toEqual({ bg: "1E3A8A", accent: "EA580C", font: "Georgia", size: "large" });
    expect(a.blocks).toHaveLength(2);
    expect(slidesOf(slideSource(a))[0].style).toEqual(a.style);
    const t = styledTheme(THEMES[0], a.style);
    expect(t.dark).toBe(true);
    expect(t.text).toBe("F1F5F9");
    expect(t.bodyFont).toBe("Georgia");
    expect(styledTheme(THEMES[0], { bg: "FFFFFF", accent: "FFFFFF" }).accent).toBe(THEMES[0].accent);
    const l = layoutSlide(a, THEMES[0], { index: 1, count: 3, pics: {} });
    expect(l.bg).toBe("1E3A8A");
    expect(l.overflow).toEqual([]);
  });
});

describe("sources and exact quotes", () => {
  const src = "Vietnam joined the WTO in January 2007 as its 150th member, after eleven years of negotiations. Foreign-invested firms produce 77% of exports.";
  it("keeps a quote that is in the text, repairs a reworded one with the real sentence, drops an invented one", async () => {
    const { exactQuote } = await import("../src/core/deckBuild");
    expect(exactQuote("Foreign-invested firms produce 77% of exports", src)).toBe("Foreign-invested firms produce 77% of exports.");
    expect(exactQuote("Foreign invested companies produce 77% of the exports", src)).toBe("Foreign-invested firms produce 77% of exports.");
    expect(exactQuote("Vietnam is the best economy in the world today", src)).toBeNull();
  });
  it("lists the sources of the web research, the cited ones first", async () => {
    const { webSources, sourcesSlide, userRequest } = await import("../src/core/deckBuild");
    const req = `make a deck about Vietnam\n\n<search_results query="v">\nSources:\n[1] Trade report — https://www.example.org/a\n[2] IMF note — https://imf.org/b\n</search_results>`;
    expect(userRequest(req)).toBe("make a deck about Vietnam");
    const found = webSources(req);
    expect(found.map((f) => f.n)).toEqual([1, 2]);
    const s = sourcesSlide([{ title: "x", lines: [{ text: "Exports rose [2]", level: 0, bullet: true }], table: null, notes: "" }], found)!;
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].text).toContain("imf.org");
  });
});

describe("changing a finished deck", () => {
  it("an edit block changes one line of the text form, and the new elements still build a real .pptx", async () => {
    const { applyEdits } = await import("../src/core/review");
    const { buildPptx, slidesOf } = await import("../src/core/slides");
    const src = "Theme: clean\n\n---\n\n# Cover\nA subtitle\n\n---\n\n# Numbers\nStyle: bg=navy accent=orange font=Georgia\nStats: $930bn | Trade ; 180% | of GDP\nCallout: Opened up and grew\nQuote: Trade is the engine | A minister\n\n---\n\n# Pillars\nColumn: A | one ; two\nColumn: B | three ; four\n";
    const r = applyEdits(src, [{ search: "Stats: $930bn | Trade ; 180% | of GDP", replace: "Stats: $930bn | Trade ; 180% | of GDP ; 8% | Growth" }, { search: "bg=navy", replace: "bg=teal" }]);
    expect(r.applied).toBe(2);
    const [, b] = slidesOf(r.content);
    expect(b.stats).toHaveLength(3);
    expect(b.style?.bg).toBe("0D9488");
    const bytes = await buildPptx(r.content);
    expect(bytes.length).toBeGreaterThan(2000);
    expect(String.fromCharCode(...bytes.slice(0, 2))).toBe("PK");
  });
});
