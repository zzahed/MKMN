// Websites from the template, scored by the page rubric (src/core/fileQuality.ts). The first real run of the rubric on the
// template's own output found a button that leads nowhere: with no link of its own, a button points at #contact, but the contact
// section's id came from its title ("Visit us" → #visit-us).
import { beforeAll, describe, expect, it } from "vitest";
import { SITE_TEMPLATES } from "../src/core/templates/site";
import { pageQuality } from "../src/core/fileQuality";
import { loadIcons } from "../src/core/page/iconTable";
import { SITE_SCENARIOS, evaluateFileScenario } from "../src/core/harness/fileEval";
import { QUALITY_BAR } from "../src/core/harness/quality";

beforeAll(async () => { await loadIcons(); });
const site = SITE_TEMPLATES.find((t) => t.id === "site")!;

export const CAFE = {
  title: "Green Bean Café",
  sections: [
    { type: "hero", title: "Green Bean Café", subtitle: "Coffee roasted in the back room every morning", cta: "See the menu" },
    { type: "features", title: "Why people come back", items: [{ title: "Fresh roast", text: "Beans roasted daily in small batches for a sweeter cup." }, { title: "Quiet tables", text: "Long tables and soft light make it easy to work for hours." }, { title: "Local bakery", text: "Pastries arrive at seven from the bakery two streets away." }] },
    { type: "faq", title: "Questions", items: [{ q: "Do you have oat milk?", a: "Yes, oat and almond milk are free with every drink." }, { q: "Can I book a table?", a: "Tables are first come, but the back room can be booked for groups." }] },
    { type: "contact", title: "Visit us", text: "Open every day from seven in the morning until six in the evening, two minutes from the station." },
  ],
};

describe("the website template's own links", () => {
  it("a button with no link of its own reaches the contact section, whatever the section is called", () => {
    const html = site.render(CAFE).source;
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const dead = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((a) => !ids.has(a));
    expect(dead).toEqual([]);
  });
  it("a well-filled page passes the page rubric", () => {
    expect(pageQuality(site.render(CAFE).source)).toEqual({ score: 1, failed: [] });
  });
  it("a thin page of placeholders does not", () => {
    const thin = { title: "Café", sections: [{ type: "hero", title: "Café" }, { type: "features", title: "Features", items: [{ title: "Feature 1", text: "Lorem ipsum dolor sit amet." }, { title: "Feature 2", text: "Lorem ipsum dolor sit amet." }] }, { type: "cta", title: "Contact" }] };
    const q = pageQuality(site.render(thin).source);
    expect(q.score).toBeLessThan(QUALITY_BAR);
    expect(q.failed.map((f) => f.id)).toEqual(expect.arrayContaining(["substance", "noFiller"]));
  });
});

describe("the website eval", () => {
  it("every scripted model persona yields a page at or above the bar", async () => {
    expect(SITE_SCENARIOS.length).toBeGreaterThan(0);
    for (const s of SITE_SCENARIOS) {
      const res = await evaluateFileScenario(s);
      expect(res.pass, `${s.id}: ${res.detail ?? ""}`).toBe(true);
    }
  });
});
