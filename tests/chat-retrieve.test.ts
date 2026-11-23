// The retrieve stage's quoted answers (src/core/chatRetrieve.ts): the question read off the
// conversation, and the answer quoted straight from the documents when one passage settles it
// (an ownership stake, a reported figure), with no model call. Pure: no host, no model.
import { describe, expect, it } from "vitest";
import { readDocumentQuestion } from "../src/core/chatRetrieve";
import type { ChatMessage } from "../src/shared/types";

const user = (content: string): ChatMessage => ({ role: "user", content });
const knowledge = (content: string) => ({ knowledge: [{ id: "k1", name: "deal.txt", content }] });
const STAKE = "Northstar acquired a 60% stake in Acme, with Harbor retaining 40% ownership.";
const FIGURE = "Acme reported net income of 12.4 million dollars for Q2 2026.";

describe("readDocumentQuestion", () => {
  it("no documents: nothing is quoted, and the question is read for the steps that follow", () => {
    const q = readDocumentQuestion([user("How much does Northstar own in Acme?")], {});
    expect(q.quoted).toBeNull();
    expect(q).toMatchObject({ hasSources: false, verification: false, priorAsk: undefined, knowledgeFiles: [] });
  });

  it("an ownership question is answered from the passage that names the stake, cited", () => {
    const q = readDocumentQuestion([user("How much does Northstar own in Acme?")], knowledge(`History.\n\n${STAKE}\n\nNotes.`));
    expect(q.quoted?.kind).toBe("ownership");
    expect(q.quoted?.text).toContain(`> ${STAKE}`);
    expect(q.quoted?.text).toContain("deal.txt");
    expect(q.quoted?.sections).toHaveLength(1);
    expect(q.quoted?.input).toMatchObject({ query: "How much does Northstar own in Acme?" });
  });

  it("an ownership question the documents cannot settle is declined, with no section cited", () => {
    const q = readDocumentQuestion([user("How much does Aramco own in HUMAIN?")], knowledge("49% of readers knew HUMAIN. Aramco is a shareholder."));
    expect(q.quoted?.kind).toBe("ownership");
    expect(q.quoted?.text).toBe("I couldn't verify the ownership percentage from an unambiguous passage in the available documents.");
    expect(q.quoted?.sections).toEqual([]);
  });

  it("a reported figure for a named period is quoted from its sentence, with the time it took", () => {
    const q = readDocumentQuestion([user("What was Acme's net income for Q2 2026?")], knowledge(`Report.\n\n${FIGURE}\n\nOutlook.`));
    expect(q.quoted?.kind).toBe("figure");
    expect(q.quoted?.text).toContain(`> ${FIGURE}`);
    expect(q.quoted?.input).toMatchObject({ quoted: "one", timings: { figureMs: expect.any(Number) } });
    expect(q.quoted?.log).toMatch(/^answered from the source \(one passage\) in [\d.]+ ms, no model call$/);
  });

  it("a recheck asks the earlier question again and says it checked", () => {
    const q = readDocumentQuestion([
      user("How much does Northstar own in Acme?"), { role: "assistant", content: "40%." }, user("Double check that"),
    ], knowledge(`History.\n\n${STAKE}`));
    expect(q).toMatchObject({ verification: true, priorAsk: "How much does Northstar own in Acme?" });
    expect(q.quoted?.text).toMatch(/^I checked the source again\./);
  });

  it("a request to build files is never answered by a quote", () => {
    const q = readDocumentQuestion([user("How much does Northstar own in Acme?")], { ...knowledge(STAKE), buildWanted: true });
    expect(q.quoted).toBeNull();
    expect(q.hasSources).toBe(true);
  });

  it("empty knowledge files do not count as sources", () => {
    const q = readDocumentQuestion([user("How much does Northstar own in Acme?")], knowledge("   "));
    expect(q).toMatchObject({ hasSources: false, quoted: null, knowledgeFiles: [] });
  });
});
