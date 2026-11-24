// The quality of generated Word documents, spreadsheets and web pages: the rubrics (src/core/fileQuality.ts), calibrated against the
// app's own templates, the pipelines that report a score and ask once more when a file is weak, and the eval personas.
import { describe, expect, it } from "vitest";
import { docxQuality, pageQuality, xlsxQuality } from "../src/core/fileQuality";
import { EXCEL_TEMPLATES } from "../src/core/templates/excel";
import { WORD_TEMPLATES } from "../src/core/templates/word";
import { makeFromTemplate } from "../src/core/templates/build";
import type { Session } from "../src/core/build";
import { FILE_SCENARIOS, evaluateFileScenario } from "../src/core/harness/fileEval";
import { QUALITY_BAR } from "../src/core/harness/quality";
import type { ChatEvent, ChatStats } from "../src/shared/types";

const stats: ChatStats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };

describe("the Word rubric", () => {
  it("a real document passes, a shell of headings does not", () => {
    const report = WORD_TEMPLATES.find((t) => t.id === "report")!.render({ title: "Q3 Support Review", summary: "Ticket volume rose 18% while the median first reply fell to four hours after the new triage rota.", sections: [{ heading: "Volume", text: "Most new tickets came from the billing page after the September price change." }, { heading: "Response", text: "The rota put two people on first replies each morning, which halved the backlog." }], conclusion: "Keep the rota and fix the billing page copy." }).source;
    expect(docxQuality(report).score).toBe(1);
    const shell = docxQuality("# Report\n\n## Summary\n\n## Findings\n");
    expect(shell.score).toBeLessThan(QUALITY_BAR);
    expect(shell.failed.map((f) => f.id)).toEqual(expect.arrayContaining(["substance", "noEmptySections"]));
  });
  it("names filler, a repeated paragraph, and a long text without headings", () => {
    const filler = docxQuality(`# Plan\n\n${"Lorem ipsum dolor sit amet, the plan covers the next quarter of work for everyone involved. ".repeat(3)}`);
    expect(filler.failed.map((f) => f.id)).toContain("noFiller");
    const p = "The new rota halved the backlog within three weeks for every customer group.";
    expect(docxQuality(`# Memo\n\n## A\n${p}\n\n## B\n${p}\n\nOther words to make it long enough for the check to count it as a real document today.`).failed.map((f) => f.id)).toContain("noRepeats");
    const long = Array.from({ length: 30 }, (_, i) => `Sentence ${i} tells something different about topic number ${i} and its own particular detail.`).join(" ");
    expect(docxQuality(`# Notes\n\n${long}`).failed.map((f) => f.id)).toContain("structure");
  });
  it("a [placeholder] for what the request did not give is honest, not filler", () => {
    expect(docxQuality("# Letter\n\nDear [Name],\n\nI am writing to resign from my post as support lead, with my last day four weeks from today as my contract requires. Thank you for the years of trust and the chance to build the team.\n\nSincerely,\n[Your name]").failed.map((f) => f.id)).not.toContain("noFiller");
  });
});

describe("the spreadsheet rubric", () => {
  it("every Excel template of the app, rendered empty, scores clean: its formulas all compute", () => {
    for (const t of EXCEL_TEMPLATES) expect(xlsxQuality(t.render({ title: t.name }).source), t.id).toEqual({ score: 1, failed: [] });
  });
  it("names a formula that does not compute, a typed total, a missing header", () => {
    const q = xlsxQuality("## S\n| Item | | Cost |\n|---|---|---|\n| Paper | 1 | =B2*X(2 |\n| Total | | 189 |");
    expect(q.failed.map((f) => f.id)).toEqual(expect.arrayContaining(["formulasCompute", "totalsAreFormulas", "headers"]));
  });
  it("a blank row's share of nothing is not an error", () => {
    expect(xlsxQuality("## S\n| Item | Planned | Actual | Used |\n|---|---|---|---|\n| Rent | 800 | 800 | =C2/B2 |\n| | | | =C3/B3 |").failed).toEqual([]);
  });
});

describe("the page rubric", () => {
  const page = (body: string, extra = "") => `<!doctype html><html><head><title>Green Bean Café</title></head><body><nav><a href="#about">About us</a><a href="#menu">Menu</a></nav>${extra}${body}</body></html>`;
  const GOOD = `<h1>Green Bean Café</h1><section id="about"><h2>About us</h2><p>Beans are roasted every morning in the back room, in small batches for a sweeter cup.</p><p>Long tables and soft light make it easy to stay and work for hours.</p></section><section id="menu"><h2>Menu</h2><ul><li>Espresso drinks made with our house blend and oat or almond milk at no extra cost.</li><li>Pastries delivered at seven from the bakery two streets away, until they run out.</li></ul></section><section id="visit"><h2>Visit</h2><p>Open every day from seven in the morning until six in the evening, near the station.</p><img src="x.jpg" alt="The front counter"></section>`;
  it("a real page passes; the menu repeating the section titles is not a repeat", () => {
    expect(pageQuality(page(GOOD))).toEqual({ score: 1, failed: [] });
  });
  it("names filler, repeats, a link to nowhere, a picture with no alt, and an empty page", () => {
    const bad = pageQuality(page(`<h1>Site</h1><section><h2>Feature 1</h2><p>Lorem ipsum dolor sit amet for the whole page.</p><p>Lorem ipsum dolor sit amet for the whole page.</p><img src="a.jpg"></section>`));
    expect(bad.failed.map((f) => f.id)).toEqual(expect.arrayContaining(["substance", "noFiller", "noRepeats", "anchors", "imageAlt"]));
    expect(bad.score).toBeLessThan(QUALITY_BAR);
  });
});

describe("the pipelines ask once more when a file is weak, and report the score", () => {
  const drive = async (reply: (sid: string, asked: string) => string, request: string) => {
    const calls: string[] = [];
    const stream: Session = async function* (sid, messages): AsyncGenerator<ChatEvent> {
      calls.push(sid);
      yield { id: "x", type: "answer", text: reply(sid, String(messages[messages.length - 1]?.content ?? "")) };
      yield { id: "x", type: "done", stats };
    };
    const events: ChatEvent[] = [];
    const gen = makeFromTemplate({ id: "x", messages: [{ role: "user", content: request }], stream, drawEveryMs: 0 });
    let r = await gen.next();
    while (!r.done) { events.push(r.value); r = await gen.next(); }
    const last = events.filter((e) => e.type === "build").pop();
    return { calls, quality: last?.type === "build" ? last.build.quality : undefined, text: r.value.handled ? r.value.text : "" };
  };
  const GOOD_DOC = "# Q3 Support Review\n\n## Summary\nTicket volume rose 18% in the quarter while the median first reply fell from nine hours to four after the new triage rota started.\n\n## Next\nRewrite the billing FAQ in plain words and add a second evening shift during product launches.";
  it("a good free document is written once, and its score rides the build", async () => {
    const r = await drive((sid) => (sid.endsWith(":template") ? '{"template":"none"}' : /free/.test(sid) ? GOOD_DOC : "Done."), "write a Word memo about our Q3 support numbers");
    expect(r.calls.filter((c) => /free/.test(c))).toHaveLength(1);
    expect(r.quality).toMatchObject({ rubric: "docx", score: 1 });
  });
  it("a weak free document is asked again with what is wrong, and the better one is kept", async () => {
    const asked: string[] = [];
    const r = await drive((sid, a) => { if (/free/.test(sid)) asked.push(a); return sid.endsWith(":template") ? '{"template":"none"}' : /free:docx:1/.test(sid) ? GOOD_DOC : /free/.test(sid) ? "# Q3\n\n## Summary\n\n## Next\n" : "Done."; }, "write a Word memo about our Q3 support numbers");
    expect(r.calls.filter((c) => /free/.test(c))).toHaveLength(2);
    expect(asked[1]).toMatch(/says almost nothing/);
    expect(r.text).toContain("median first reply");
    expect(r.quality?.score).toBe(1);
  });
  it("a second try that is worse never replaces the first", async () => {
    const weak = "# Q3 Review\n\n## Summary\nVolume rose 18% and replies got faster.\n\n## Next\n";
    const r = await drive((sid) => (sid.endsWith(":template") ? '{"template":"none"}' : /free:docx:1/.test(sid) ? "# X\n\n## A\n\n## B\n\n## C\n" : /free/.test(sid) ? weak : "Done."), "write a Word memo about our Q3 support numbers");
    expect(r.text).toContain("Volume rose 18%");
  });
});

describe("the file eval", () => {
  it("every scripted model persona yields a file at or above the bar", async () => {
    for (const s of FILE_SCENARIOS) {
      const res = await evaluateFileScenario(s);
      expect(res.pass, `${s.id}: ${res.detail ?? ""}`).toBe(true);
    }
  });
});
