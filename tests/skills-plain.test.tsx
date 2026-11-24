// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { autoSkill, skillProblems, triggerForInput, triggerFromInput, type Skill } from "../src/core/skills";
import { INSTRUCTION_CONTEXT } from "../src/core/instructions";
import { Customize } from "../src/renderer/Customize";

/**
 * Phase 3, round 2 (docs/design/usability-audit.md): a skill starts by itself from plain
 * words, deleting your own skill asks first, and About me tells the truth about which
 * parts a model reads (the conversation length, not the model's size).
 */
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("start by itself, in plain words", () => {
  it("turns comma-separated words into the pattern a skill starts on, and back", () => {
    const when = triggerFromInput("invoice, bill , cover letter");
    expect(when).toBe(String.raw`(?<![\p{L}\p{N}_])(?:invoice|bill|cover letter)(?![\p{L}\p{N}_])`);
    expect(triggerForInput(when)).toBe("invoice, bill, cover letter");
    expect(triggerFromInput("   ")).toBeUndefined();
    expect(triggerFromInput(" , ")).toBeUndefined();
    // the earlier saved form still reads back as words
    expect(triggerForInput(String.raw`\b(invoice|bill)\b`)).toBe("invoice, bill");
  });

  const skill = (when: string | undefined) => ({ id: "s", name: "S", description: "A test skill", tags: [], models: [], instructions: "", steps: [{ title: "a", prompt: "b" }], when }) as unknown as Skill;

  it("Arabic words start a skill too, and only as whole words", () => {
    const s = skill(triggerFromInput("فاتورة, invoice"));
    expect(autoSkill([s], "أرسل لي هذه فاتورة الشهر", false)?.id).toBe("s");
    expect(autoSkill([s], "الفاتورات كثيرة", false)).toBeFalsy(); // part of a longer word is not the word
    expect(autoSkill([s], "Send the invoice", false)?.id).toBe("s");
    expect(autoSkill([s], "invoices are due", false)).toBeFalsy();
  });

  it("words with symbols stay words: C++ is valid, and e.g. does not match 'eXgX'", () => {
    const cpp = skill(triggerFromInput("C++"));
    expect(skillProblems(cpp)).toEqual([]);
    expect(autoSkill([cpp], "Help me with C++ templates", false)?.id).toBe("s");
    const eg = skill(triggerFromInput("e.g., v1.2"));
    expect(autoSkill([eg], "eXgX", false)).toBeFalsy();
    expect(autoSkill([eg], "upgrade to v1.2 today", false)?.id).toBe("s");
    expect(triggerForInput(eg.when)).toBe("e.g., v1.2");
  });

  it("a hand-written pattern compiles exactly as before (no u flag forced on it)", () => {
    // \- is fine without u and a syntax error with it: old patterns must keep working
    const old = skill(String.raw`\b(re\-send|bill)\b`);
    expect(skillProblems(old)).toEqual([]);
    expect(autoSkill([old], "please re-send it", false)?.id).toBe("s");
  });

  it("keeps a real regular expression exactly as written", () => {
    const re = String.raw`\b(inv(oice)?|bill)\b`;
    expect(triggerFromInput(re)).toBe(re);
    expect(triggerForInput(re)).toBe(re);
  });

  it("a skill made from words really starts on those words, and not on others", () => {
    const s = { id: "billing", name: "Billing", description: "", tags: [], models: [], instructions: "", steps: [{ title: "a", prompt: "b" }], when: triggerFromInput("invoice, bill") } as unknown as Skill;
    expect(autoSkill([s], "Please draft an invoice for March", false)?.id).toBe("billing");
    expect(autoSkill([s], "Please draft a poem", false)).toBeFalsy();
  });

  it("the error names the box the person sees, never the field 'when'", () => {
    const bad = skillProblems({ id: "x", name: "X", description: "d", tags: [], models: [], instructions: "", steps: [{ title: "a", prompt: "b" }], when: "(" } as unknown as Skill);
    expect(bad.join(" ")).toContain('"start by itself"');
    expect(bad.join(" ")).not.toMatch(/"when"/);
  });
});

describe("About me is truthful about which parts are read", () => {
  it("the part 2 and 3 thresholds the copy names are the code's own (8K and 16K tokens, about 6,000 and 12,000 words)", () => {
    expect(INSTRUCTION_CONTEXT[1]).toBe(8192);
    expect(INSTRUCTION_CONTEXT[2]).toBe(16384);
    const src = readFileSync("src/renderer/Customize.tsx", "utf8");
    expect(src).toContain("Long (about 6,000 words)");
    expect(src).toContain("about 12,000 words or more");
    expect(src).not.toMatch(/larger models|mid-size|smallest/);
  });
});

describe("deleting a skill you own asks first", () => {
  // the starter skills (Brainstorm ideas…) are the person's own: deleting one is permanent
  it("Cancel keeps it; OK deletes it; a built-in skill is only uninstalled, without asking", async () => {
    const saves: unknown[] = [];
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<Customize settings={{} as any} onSave={async (p) => { saves.push(p); }} onOpenDocs={() => {}} />);
    expect(screen.getByRole("button", { name: "Uninstall Arcade game" }).getAttribute("title")).toBe("Uninstall (you can put it back from this list)");
    fireEvent.click(screen.getByRole("button", { name: "Delete Brainstorm ideas" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toContain("This cannot be undone. To keep a copy, export it as a .md file first.");
    await Promise.resolve();
    expect(saves).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Delete Brainstorm ideas" }));
    await Promise.resolve();
    expect(saves.length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Arcade game" }));
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(2); // uninstalling asked nothing
    expect(saves.length).toBe(2);
  });
});
