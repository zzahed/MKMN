/**
 * The one identity of the assistant: MKMN AI. Three layers live here and in the
 * registry:
 *
 *  1. `IDENTITY_INSTRUCTIONS`, registered in INSTRUCTION_BLOCKS (src/core/prompts.ts)
 *     with the top priority, so every assembled system prompt carries it. It is re-sent
 *     fresh after every compaction and never summarized.
 *  2. `guardAnswerText` and `IdentityStreamGuard`, used as the harness `afterStep`
 *     hook (`identityGuard`) on every answer the person sees or hears. They find
 *     self-identifying sentences that use a forbidden name and rewrite the name to
 *     "MKMN AI", dropping a maker clause, and self-descriptions that name nothing
 *     at all, which become the fixed answer. Text where another product
 *     is the topic is never changed.
 *  3. The user-facing strings of the app itself say "MKMN AI" (see src/shared/brand.ts).
 *
 * This is a safety net on top of the instructions, never a way of deciding what a
 * request means.
 */
import identityNames from "./identity-names.json";
import type { InstructionBlock } from "../prompts";
import type { ChatEvent } from "../../shared/types";

export const ASSISTANT_NAME = identityNames.assistantName as string;

/** The identity block: every route's system prompt carries it first. No quoted sentence a small model could copy as its answer — the real runs on the smallest chat model answered plain knowledge questions with the quoted self-introduction verbatim (13 of 39 in an earlier build); the name and the rules only. The fixed answer is written by the guard below, never offered as an example. */
export const IDENTITY_INSTRUCTIONS = `You are ${ASSISTANT_NAME}, the person's personal assistant running on this PC.
- If asked who you are or who made you, say you are ${ASSISTANT_NAME}, the person's assistant on this PC.
- Never name or invent a model, engine or company as what you are or made you.
- In Arabic, keep "${ASSISTANT_NAME}" in Latin letters.
- Speak as "I", never "we".
- Another AI product in a question is a topic: answer it as one; they only decide how you name YOURSELF.`;

/** The registered block: top priority, relevant everywhere. */
export const IDENTITY_BLOCK: InstructionBlock = {
  name: "identity",
  covers: "IDENTITY_INSTRUCTIONS",
  priority: 140,
  when: () => true,
  text: IDENTITY_INSTRUCTIONS,
};

/** Prepend the identity block to a system prompt that may not have it (idempotent). */
export function withIdentity(system: string): string {
  const marker = IDENTITY_INSTRUCTIONS.split("\n")[0];
  if (system.includes(marker)) return system;
  return system ? `${IDENTITY_INSTRUCTIONS}\n\n${system}` : IDENTITY_INSTRUCTIONS;
}

// ---------------------------------------------------------------- the names

const MODELS = (identityNames.models as string[]).slice().sort((a, b) => b.length - a.length);
const ENGINES = (identityNames.engines as string[]).slice().sort((a, b) => b.length - a.length);
const MAKERS = [...(identityNames.makers as string[]), ...(identityNames.arabicMakers as string[])].slice().sort((a, b) => b.length - a.length);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Word-bounded alternative of every name, longest first. */
const alt = (names: string[]) => names.map(escapeRe).join("|");
const NAME_RE = new RegExp(`(?:${alt([...MODELS, ...ENGINES])})`, "giu");

/** First-person cues: the sentence speaks about the assistant itself. Arabic letters are not ASCII word characters, so the edges are letter look-arounds, never \b. */
const SELF_CUE =
  /(?<![\p{L}\p{N}])(?:I|I'm|I am|my name|me|myself|أنا|اسمي|نفسي)(?![\p{L}\p{N}])|و?تم\s+(?:تطويري|إنشائي|تصميمي|تدريبي)|طوَّرتُ|صنعتُ/u;
/** A denial is not self-identification: "I am not <name>" is already the truth. */
const NEGATION = /\b(?:not|n't|never)\b|لا\s|لست\s|ليس\s/u;

/** The sentence names itself: copula + name, "my name is <name>", "<name> here", "powered by <name>". */
function selfNamingPattern(name: string): RegExp {
  const n = escapeRe(name);
  return new RegExp(
    [
      `\\bI\\s*(?:'| a)?m\\s+(?:not\\s+)?(?:an?\\s+|the\\s+)?(?:model\\s+|language\\s+model\\s+|AI\\s+|assistant\\s+)?${n}\\b`,
      `\\bI\\s+am\\s+(?:not\\s+)?${n}\\b`,
      `\\bmy name is\\s+${n}\\b`,
      `\\bcall me\\s+${n}\\b`,
      `\\b${n}\\s+here\\b`,
      `\\bI(?:'m| am)?\\s+(?:powered|built|running)\\s+(?:by|on|with)\\s+(?:the\\s+)?${n}\\b`,
      `\\bI\\s+use\\s+${n}\\b`,
      // Arabic: أنا <name> / اسمي <name> / <name> هو اسمي
      `أنا\\s+(?:نموذج\\s+|مساعدك\\s+|مساعد\\s+|نموذج اللغة\\s+)?${n}`,
      `اسمي\\s+${n}`,
      `${n}\\s+هو\\s+اسمي`,
    ].join("|"),
    "iu",
  );
}

/** The sentence names its maker: created/developed/made/built/trained by <maker> (English and Arabic). */
function makerClausePattern(maker: string): RegExp {
  const m = escapeRe(maker);
  return new RegExp(
    [
      `,?\\s*(?:and\\s+)?(?:it(?:'s| is)?\\s+)?(?:I(?:'m| am)?\\s+)?(?:was\\s+|were\\s+|'m\\s+|am\\s+)?(?:created|developed|made|built|trained|designed|crafted|released)\\s+by\\s+(?:the\\s+)?${m}\\b`,
      `\\b(?:created|developed|made|built|trained|designed)\\s+by\\s+(?:the\\s+)?${m}\\b`,
      `\\bby\\s+(?:the\\s+)?${m}\\b`,
      // Arabic: تم تطويري بواسطة علي بابا / من تطوير / من إنتاج
      `،?\\s*(?:و)?تم\\s+(?:تطويري|إنشائي|تصميمي|تدريبي)\\s+بواسطة\\s+${m}`,
      `\\bمن\\s+(?:تطوير|إنتاج|صنع)\\s+${m}`,
      `\\bبواسطة\\s+${m}`,
    ].join("|"),
    "iu",
  );
}

/** "I was created by <maker>" as the whole predicate: the sentence becomes the fixed answer. */
const WHOLE_MAKER_SENTENCE =
  /^\s*(?:yes,?\s*)?I\s+(?:'m\s+|am\s+|was\s+|were\s+)?(?:created|developed|made|built|trained|designed|crafted)\s+by\b/i;

/**
 * An unnamed self-description: the sentence OPENS as "I am <a generic assistant/AI/model
 * noun>" (English or Arabic), so its whole predicate is who the assistant is. With no name
 * of a model or engine in it (the older shape above) there is nothing to rewrite — the
 * real runs (the 7b tag) let such answers through with no name at all. A denial keeps it from
 * matching: "I am not just a chatbot" is already the truth, never rewritten into a claim.
 */
const UNNAMED_SELF_DESC =
  /(?:^\s*(?:yes,?\s*)?I\s*(?:'|’)?\s*(?:am|m)\s+(?:just\s+|really\s+|actually\s+)?(?:an?\s+|the\s+|your\s+)?(?:digital\s+|virtual\s+|personal\s+|language\s+|AI\s+)?(?:assistant|model|chatbot|bot|program|AI)\b)|(?:^\s*أنا\s+(?:مساعد|نموذج|ذكاء|برنامج))/iu;

/** The script a sentence is written in, by its own letters: Arabic when the Arabic letters outnumber the Latin ones. */
function scriptOfSentence(s: string): "ar" | "en" {
  const ar = (s.match(/\p{Script=Arabic}/gu) ?? []).length;
  const la = (s.match(/\p{Script=Latin}/gu) ?? []).length;
  return ar > la ? "ar" : "en";
}

/** The fixed answer of an unnamed self-description, in the sentence's own script (the name stays in Latin letters). */
const SELF_ANSWER = {
  en: `I am ${ASSISTANT_NAME}, your assistant on this PC.`,
  ar: `أنا ${ASSISTANT_NAME}، مساعدك على هذا الكمبيوتر.`,
};

// ---------------------------------------------------------------- the guard

/** Split into sentence pieces, each keeping its own trailing whitespace, so a join of untouched pieces is byte-identical. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "." || c === "!" || c === "?" || c === "؟" || c === "…" || c === "\n") {
      let end = i + 1;
      while (end < text.length && /\s/.test(text[end])) end++;
      out.push(text.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Rewrite one sentence. A sentence that does not speak about the assistant itself is returned untouched. */
export function guardSentence(sentence: string): string {
  NAME_RE.lastIndex = 0;
  const namesItself = NAME_RE.test(sentence);
  const unnamed = !namesItself && !NEGATION.test(sentence) && UNNAMED_SELF_DESC.test(sentence);
  if (!namesItself && !WHOLE_MAKER_SENTENCE.test(sentence) && !unnamed) return sentence;
  if (!SELF_CUE.test(sentence)) return sentence; // another product is the topic: never touched

  let s = sentence;
  // 1. An unnamed self-description ("I am a digital assistant on this computer."): no name to
  //    rewrite, so the sentence becomes the fixed answer, in the sentence's own script.
  if (unnamed) {
    const lead = sentence.match(/^\s*/)![0];
    const tail = sentence.match(/\s*$/)![0];
    return `${lead}${SELF_ANSWER[scriptOfSentence(sentence)]}${tail}`;
  }
  // 2. "I was created by <maker>." as the whole sentence becomes the fixed answer.
  if (WHOLE_MAKER_SENTENCE.test(s)) {
    const lead = s.match(/^\s*/)![0];
    const end = /([.!?…])\s*$/.exec(s)?.[1];
    return `${lead}I am ${ASSISTANT_NAME}${end ?? "."}`;
  }
  // 3. Drop the maker clause(s): the origin is never named.
  for (const maker of MAKERS) {
    const re = makerClausePattern(maker);
    if (re.test(s)) s = s.replace(re, (match) => (/^[,.]/.test(match) ? "" : " "));
  }
  s = s.replace(/\s{2,}/g, " ").replace(/\s+([.!?…])/g, "$1").replace(/,\s*([.!?…])/g, "$1");
  // 4. Replace every self-name with the one name.
  for (const name of [...MODELS, ...ENGINES]) {
    const re = selfNamingPattern(name);
    if (!re.test(s)) continue;
    s = s.replace(new RegExp(re.source, re.flags.replace("g", "") + "g"), (match) => {
      // A denial names the other product as what the assistant is NOT: the truth, never rewritten.
      if (/\b(?:not|n't|never)\b|لا\s|لست\s|ليس\s/u.test(match)) return match;
      return match.replace(NAME_RE, ASSISTANT_NAME);
    });
    break;
  }
  return s;
}

/** The full-text guard: every self-identifying sentence names MKMN AI, every other sentence is untouched. */
export function guardAnswerText(text: string): string {
  if (!text) return text;
  // The sentence gate in guardSentence decides; untouched pieces join back byte-identical.
  return sentences(text).map(guardSentence).join("");
}

/**
 * The harness afterStep hook: an ok step's reply (and its answer when it is a
 * string) is guarded before the step is journaled and yielded, so no answer the
 * person sees or hears names anything but MKMN AI. A step that did not settle ok
 * has no answer to show; its error text is the app's own and is never rewritten.
 */
export function identityGuardStep<S extends { status: string; reply?: string; output?: unknown }>(step: S): S {
  if (step.status !== "ok") return step;
  const reply = typeof step.reply === "string" ? guardAnswerText(step.reply) : undefined;
  const output = typeof step.output === "string" ? guardAnswerText(step.output) : undefined;
  if (reply === step.reply && output === step.output) return step;
  return { ...step, ...(reply !== undefined ? { reply } : {}), ...(output !== undefined ? { output } : {}) } as S;
}

/**
 * The stream guard: corrects self-identifying sentences that arrive across chunk
 * boundaries. Text is emitted as it arrives up to the last complete sentence; a
 * sentence that opens with a first-person cue is held until it completes, so a name
 * split across chunks ("Qw" + "en") is still caught before it is shown or spoken.
 * The held part costs nothing at the voice (which already speaks sentence by
 * sentence) and at most one short sentence at the screen.
 */
export class IdentityStreamGuard {
  private pending = "";

  /** The corrected text that is safe to emit now. */
  push(delta: string): string {
    this.pending += delta;
    const boundary = endOfLastSentence(this.pending);
    if (boundary <= 0) return "";
    const complete = this.pending.slice(0, boundary);
    this.pending = this.pending.slice(boundary);
    return guardAnswerText(complete);
  }

  /** Whatever is still held, corrected. */
  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return guardAnswerText(rest);
  }
}

/** The end of the last complete sentence in `text`, or 0 when there is none. The unfinished tail is what a stream guard holds back, so a name split across chunks is caught. */
export function endOfLastSentence(text: string): number {
  let cut = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "." && c !== "!" && c !== "?" && c !== "؟" && c !== "…" && c !== "\n") continue;
    let end = i + 1;
    while (end < text.length && /\s/.test(text[end])) end++;
    cut = end;
    i = end - 1;
  }
  return cut;
}

/**
 * The stream guard over the chat's own events: it maps the events a model call
 * yields (answer deltas, retracts, done) to the events the person may see and
 * hear. Answer deltas flow out exactly as they arrive — the screen and the voice
 * never wait — while every complete sentence is guarded before it can stand: a
 * sentence that names another model is taken back (one retract event) and re-sent
 * corrected, the same way the transport takes back a failed attempt. The raw
 * answer is kept as the ground truth, so a transport's own retract (a restart, a
 * loop cut) lands on the same words the person holds and the sentence the cut
 * opens is guarded whole when it completes. The final `done` flushes the last
 * unfinished sentence first, so nothing unsent reaches the answer after it.
 */
export class IdentityEventGuard {
  /** Complete sentences the guard has settled: how much raw they consumed, how much guarded text they left, and their raw text when it was rewritten. */
  private segs: { raw: number; out: number; rawText?: string }[] = [];
  /** The raw answer so far (every delta, with the transport's own retracts applied): the ground truth of what the person's text is built from. */
  private rawAll = "";

  constructor(private readonly id: string) {}

  private rawSum(): number {
    return this.segs.reduce((n, s) => n + s.raw, 0);
  }

  private outSum(): number {
    return this.segs.reduce((n, s) => n + s.out, 0);
  }

  /** The events to forward for one event from the model call (the event itself last, when it passes). */
  event(ev: ChatEvent): ChatEvent[] {
    if (ev.type === "answer") {
      this.rawAll += ev.text;
      const open = this.rawAll.slice(this.rawSum());
      const b = endOfLastSentence(open);
      if (b === 0) return [ev]; // inside a sentence: the raw words go out as they come
      const complete = open.slice(0, b);
      const batch = sentences(complete).map((s) => ({ s, safe: guardAnswerText(s) }));
      if (batch.every((x) => x.safe === x.s)) {
        // the common path: every sentence passes as it is, and the raw delta stays on the screen
        for (const x of batch) this.segs.push({ raw: x.s.length, out: x.s.length });
        return [ev];
      }
      // a sentence was rewritten: the whole open tail is taken back and re-sent — the
      // corrected sentence in place of its raw words, the rest as it is — because the
      // raw deltas of this batch were never sent (they arrived inside this one delta)
      const events: ChatEvent[] = [{ id: this.id, type: "retract", keep: this.outSum() }];
      for (const x of batch) {
        this.segs.push({ raw: x.s.length, out: x.safe.length, ...(x.safe !== x.s ? { rawText: x.s } : {}) });
        events.push({ id: this.id, type: "answer", text: x.safe });
      }
      const tail = open.slice(b);
      if (tail) events.push({ id: this.id, type: "answer", text: tail }); // the unfinished words ride along again
      return events;
    }
    if (ev.type === "retract") {
      // the transport took part of the raw answer back (a restart, a loop cut): the same
      // words are taken back in guarded space, and whatever sentence the cut opens is
      // guarded whole when it completes
      this.rawAll = this.rawAll.slice(0, Math.max(0, ev.keep));
      const cut = this.rawAll.length;
      let raw = 0;
      const keep: { raw: number; out: number; rawText?: string }[] = [];
      for (const s of this.segs) {
        if (raw + s.raw <= cut) { keep.push(s); raw += s.raw; continue; }
        if (s.out === s.raw && cut > raw) keep.push({ raw: cut - raw, out: cut - raw }); // an untouched sentence splits exactly (raw is guarded 1:1)
        break; // a rewritten sentence is never split: it goes back whole into the open tail
      }
      this.segs = keep;
      return [{ ...ev, keep: keep.reduce((n, s) => n + s.out, 0) }];
    }
    if (ev.type === "done") {
      const open = this.rawAll.slice(this.rawSum());
      const safe = guardAnswerText(open);
      if (safe === open) return [ev];
      return [{ id: this.id, type: "retract", keep: this.outSum() }, { id: this.id, type: "answer", text: safe }, ev];
    }
    return [ev];
  }
}
