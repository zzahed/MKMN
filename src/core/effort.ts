import type { CatalogEntry, ChatMessage, Effort } from "../shared/types";
import type { TaskCategory } from "./dynamic";

export const EFFORTS: { id: Effort; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Thinks only as much as the request needs" },
  { id: "off", label: "Off", hint: "Answer directly, no thinking" },
  { id: "low", label: "Low", hint: "Think briefly" },
  { id: "medium", label: "Medium", hint: "Model default" },
  { id: "high", label: "High", hint: "Think carefully, check the work" }
];

export type ThinkingSupport = "toggle" | "always" | "none";

/**
 * What a model can do with the thinking level.
 * toggle = the chat template can switch thinking off; always = a "thinking" / "reasoning" release that always thinks
 * (it can still be nudged to think less or more); none = not a thinking model, the menu hides the row.
 */
export function thinkingSupport(entry: Pick<CatalogEntry, "id" | "name" | "repo">): ThinkingSupport {
  const s = `${entry.id} ${entry.name} ${entry.repo}`.toLowerCase();
  if (/thinking|reasoning|nanbeige|deepseek-r1|-r1\b|qwq/.test(s)) return "always";
  if (/qwen[-_ ]?3|nemotron|gpt-oss|smollm3|hermes/.test(s)) return "toggle";
  return "none";
}

export function visionSupport(entry: Pick<CatalogEntry, "id" | "name" | "repo">): boolean {
  const text = `${entry.id} ${entry.name} ${entry.repo}`;
  // Gemma 3's 1B build has NO vision tower (the 4B and up do): the family pattern
  // alone claimed image input for a text-only model. Name matching stays a
  // heuristic here (the artifact's mmproj/model_type is the authority); this
  // exclusion only removes its one measured false positive.
  if (/gemma[-_ ]?3/i.test(text) && /(^|[^a-z0-9])1b([^a-z0-9]|$)/i.test(text)) return false;
  return /(^|[-_ ./])vl([-_ ./]|$)|vision|llava|pixtral|smolvlm|minicpm-v|gemma[-_ ]?3|moondream|qwen[-_ ]?3[._]?[5-9]\b|qwen[-_ ]?[4-9]|gemma[-_ ]?4|llama[-_ ]?4|internvl|paligemma|idefics|molmo|glm[-_ ]?4\.?[1-9]?v|kimi[-_ ]?vl|mistral[-_ ]?small[-_ ]?3\.[1-9]|ministral[-_ ]?3|phi[-_ ]?4[-_ ]multimodal/i.test(text);
}

/**
 * How much a helper session thinks. Writing code is done at low effort (thinking only delays the file); mending a file from an
 * error, where a wrong guess costs a whole round, gets room to think.
 */
export function stageEffort(sid: string, tokPerSec?: number | null): Effort {
  // the construction engine asks short, closed questions (a form, one function): a thought of minutes would only delay each of them
  if (sid.includes(":x:")) return "off";
  // the planner's reply is a form too (a Mode line, File lines, one-line jobs), and a nudge does not
  // hold a small model back: one measured planner thought for 118 s about a plain question and then
  // answered nothing, and the person waited all of it before the first word. Like the closed asks,
  // it thinks off. The deck's planner keeps its room: its plan carries the slides themselves.
  if (/:plan(?::|$)/.test(sid)) return "off";
  // the deck's brief and look are closed JSON forms too: measured on Qwen3-8B, {"count": 1} took 258 tokens and 11.6 s,
  // a look of 60 tokens took 900 and 41 s, before the first slide was even begun
  if (/:(?:brief|look):/.test(sid)) return "off";
  // thinking costs minutes at the speed of a small model on this chip: it is only worth it where tokens come fast
  return /:(?:repair|fix)(?::|$)/.test(sid) && (tokPerSec ?? 0) >= 20 ? "medium" : "low";
}

/** Levels the menu offers for a model. "Off" only exists where the template can really switch thinking off. */
export function effortsFor(support: ThinkingSupport): Effort[] {
  return support === "toggle" ? ["auto", "off", "low", "medium", "high"] : support === "always" ? ["auto", "low", "medium", "high"] : [];
}

const HARD = new Set<TaskCategory>(["math", "reasoning", "planning"]);
const MID = new Set<TaskCategory>(["code_repair"]);
const DEMANDING = /\b(prove|proof|step[- ]by[- ]step|optimi[sz]\w*|trade-?offs?|constraints?|why does|edge cases?|complexity)\b/i;
const LONG_ASK = 500;

/**
 * The level Auto gives one request, from its kind and its words (no model call). A plain request (a mail, a translation, a chat, a page to
 * write) is answered without the minutes of thinking; maths, logic and plans think; a long or demanding one of those thinks carefully;
 * mending code thinks briefly.
 */
export function autoEffort(category: TaskCategory, words: string): { level: Effort; why: string } {
  const demanding = words.length >= LONG_ASK || DEMANDING.test(words);
  if (HARD.has(category)) return demanding ? { level: "high", why: "a demanding question" } : { level: "medium", why: "a question that needs reasoning" };
  if (MID.has(category)) return { level: demanding ? "medium" : "low", why: "mending code" };
  return { level: "off", why: "a plain request" };
}

/** A saved level the model cannot do (e.g. Off on an always-thinking model) falls to the nearest one it can. */
export function effectiveEffort(effort: Effort, support: ThinkingSupport): Effort | null {
  const allowed = effortsFor(support);
  if (!allowed.length) return null;
  if (allowed.includes(effort)) return effort;
  return effort === "off" ? "low" : "medium";
}

const HINT: Partial<Record<Effort, string>> = {
  low: "Think only briefly before answering: a few short lines at most.",
  high: "Think carefully and thoroughly before answering, and check your work."
};

/**
 * Extra request fields and message edits for one thinking level.
 * Servers differ on how they take the switch, so the common spellings are sent together and the unknown ones ignored.
 * On the verified GenieX contract (v0.10.0): the top-level `enable_think` boolean is the switch that actually
 * disables thinking; `chat_template_kwargs.enable_thinking` is accepted but silently ignored, and
 * `reasoning_format` only controls where reasoning text appears. Both spellings are sent so servers that only
 * know one of them still work. Low and High are a best-effort nudge in the system prompt; only Off is a hard switch.
 */
export function applyEffort(
  effort: Effort | null, messages: ChatMessage[], entry: Pick<CatalogEntry, "id" | "name" | "repo">
): { messages: ChatMessage[]; body: Record<string, unknown> } {
  if (!effort || effort === "auto") return { messages, body: {} }; // Auto is settled per request before this; left here it is the model's default
  const body: Record<string, unknown> = {};
  let out = messages;
  if (effort === "off") {
    body.enable_think = false;
    body.chat_template_kwargs = { enable_thinking: false };
    body.reasoning_effort = "none";
    if (/qwen[-_ ]?3/i.test(`${entry.id} ${entry.name}`)) out = appendToLastUser(out, "/no_think");
    if (/nemotron/i.test(entry.id + entry.name)) out = withSystem(out, "detailed thinking off");
  } else {
    body.chat_template_kwargs = { enable_thinking: true };
    body.reasoning_effort = effort;
    const hint = HINT[effort];
    if (hint) out = withSystem(out, hint);
  }
  return { messages: out, body };
}

export function withSystem(messages: ChatMessage[], line: string): ChatMessage[] {
  const i = messages.findIndex((m) => m.role === "system");
  if (i < 0) return [{ role: "system", content: line }, ...messages];
  const m = messages[i];
  const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  return messages.map((x, k) => (k === i ? { ...x, content: `${text}\n\n${line}` } : x));
}

function appendToLastUser(messages: ChatMessage[], line: string): ChatMessage[] {
  const i = [...messages].map((m) => m.role).lastIndexOf("user");
  if (i < 0) return messages;
  const m = messages[i];
  const content = typeof m.content === "string" ? `${m.content} ${line}` : [...m.content, { type: "text" as const, text: line }];
  return messages.map((x, k) => (k === i ? { ...x, content } : x));
}
