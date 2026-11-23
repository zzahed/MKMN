// The retrieve stage's quoted answers, taken out of runChatOrchestrator (src/core/chatOrchestrator.ts)
// as they were: the question is read off the conversation (a recheck such as "double check" asks
// the earlier question again), and when one passage of the documents settles it, the answer is
// quoted from that passage and cited, with no model call: an ownership stake (or an honest
// decline), or a reported figure for a named period (or the sentences that disagree on it). The
// orchestrator files the step, sends the answer and ends the turn. Pure: no host, no model.
import type { ChatMessage, ChatOptions } from "../shared/types";
import { citeAnswer, type CitedSection } from "./cite";
import { asksOwnership, figurePassage, namesPeriod, ownershipPassage } from "./knowledge/retrieve";
import { isFilesMessage, isMemoMessage } from "./memo";
import { documentSourcesOf, questionOf } from "./pdfSections";

const round1 = (x: number): number => Math.round(x * 10) / 10;

export interface QuotedAnswer {
  kind: "ownership" | "figure";
  /** The answer as the person reads it, citations settled. */
  text: string;
  /** The passages it cites, for the turn's citation check. */
  sections: CitedSection[];
  /** The retrieve step's input, as the journal records it. */
  input: Record<string, unknown>;
  /** A diagnostic line (numbers only), or null. */
  log: string | null;
}

export interface DocumentQuestion {
  /** The question a recheck refers to, when the latest message is a recheck. */
  priorAsk: string | undefined;
  knowledgeFiles: NonNullable<ChatOptions["knowledge"]>;
  verification: boolean;
  percentageLookup: boolean;
  periodLookup: boolean;
  hasSources: boolean;
  quoted: QuotedAnswer | null;
}

export function readDocumentQuestion(messages: ChatMessage[], opts: Pick<ChatOptions, "knowledge" | "buildWanted">): DocumentQuestion {
  const asks = messages.filter((m) => m.role === "user" && !isMemoMessage(m) && !isFilesMessage(m)).map(questionOf);
  const latestAsk = asks.at(-1) ?? "";
  const isVerification = (ask: string) => /^(?:please\s+)?(?:double[ -]check\b|(?:can you |could you )?(?:verify|check again)\b|is it the other way\b|(?:it|that) is wrong\b)/i.test(ask);
  const verification = isVerification(latestAsk);
  const priorAsk = verification ? asks.slice(0, -1).reverse().find((ask) => ask && !isVerification(ask)) : undefined;
  const sourceAsk = priorAsk || latestAsk;
  const knowledgeFiles = (opts.knowledge ?? []).filter((f) => f.content?.trim());
  const ownershipLookup = asksOwnership(sourceAsk);
  const percentageLookup = /\bpercent(?:age)?\b|%/.test(sourceAsk.toLowerCase());
  // a question that names a reporting period (a quarter, a year, a dated day) asks for a reported figure:
  // the period is part of the fact, so the evidence must hold it beside the entity and the value
  const periodLookup = namesPeriod(sourceAsk);
  const attachments = verification || ownershipLookup || percentageLookup || periodLookup ? documentSourcesOf(messages) : [];
  const hasSources = knowledgeFiles.length > 0 || attachments.length > 0;
  const question = { priorAsk, knowledgeFiles, verification, percentageLookup, periodLookup, hasSources };
  // the turn has cited nothing yet when this runs: the quote's citations are settled against its own passages
  const sections: CitedSection[] = [];
  const ownership = !opts.buildWanted && hasSources && (ownershipLookup || percentageLookup)
    ? ownershipPassage([...knowledgeFiles, ...attachments], sourceAsk) : null;
  if (!opts.buildWanted && hasSources && (ownershipLookup || ownership)) {
    if (ownership) sections.push(ownership);
    const text = ownership
      ? citeAnswer(`${verification ? "I checked the source again.\n\n" : ""}> ${ownership.passage}\n\n[source 1]`, sections).text
      : "I couldn't verify the ownership percentage from an unambiguous passage in the available documents.";
    return { ...question, quoted: { kind: "ownership", text, sections, input: { query: sourceAsk, place: ownership?.place }, log: null } };
  }
  // A reported figure (an amount, a percentage or a date tied to a named period) or a
  // recheck of an earlier answer is quoted from the sentence that holds the entity, the
  // period and the value together, cited, with no model call (the ownership answer's way,
  // measured on the retrieval benchmark). Sentences that disagree are quoted side by side;
  // no such sentence leaves the question to the model, told to say when the evidence is
  // missing or conflicting.
  let figureMs = 0;
  const figure = !opts.buildWanted && hasSources && (periodLookup || verification)
    ? (() => { const t = performance.now(); const f = figurePassage([...knowledgeFiles, ...attachments], sourceAsk, { anyCount: verification && !periodLookup }); figureMs = performance.now() - t; return f; })()
    : null;
  if (figure) {
    const quotes = figure.kind === "one" ? [figure] : figure.quotes;
    sections.push(...quotes.map(({ file, place }) => ({ file, place })));
    const lead = verification ? "I checked the source again.\n\n" : "";
    const body = figure.kind === "one"
      ? `> ${figure.passage}\n\n[source 1]`
      : `The sources do not agree on this figure:\n\n${quotes.map((q, i) => `> ${q.passage} [source ${i + 1}]`).join("\n\n")}`;
    const text = citeAnswer(`${lead}${body}`, sections).text;
    return {
      ...question,
      quoted: {
        kind: "figure", text, sections,
        input: { query: sourceAsk, quoted: figure.kind, places: quotes.map((q) => `${q.file} (${q.place})`), timings: { figureMs: round1(figureMs) } },
        log: `answered from the source (${figure.kind === "one" ? "one passage" : `${quotes.length} passages that disagree`}) in ${round1(figureMs)} ms, no model call`,
      },
    };
  }
  return { ...question, quoted: null };
}
