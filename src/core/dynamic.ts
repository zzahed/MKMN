import type { CatalogEntry, Sampling } from "../shared/types";
import { thinkingSupport } from "./effort";

/**
 * The "Dynamic" model: one entry in the model list that is really a team. Each request is sorted into a kind of task
 * (a web page, Python, a translation, a proof...) and handed to the model of the chosen size that does that kind of task
 * best, according to public, independent benchmarks (see docs/research/dynamic-model-research.md). The NPU holds one model at a
 * time, so models are switched only when the kind of task changes, and a request that is small or ambiguous stays on
 * the model that is already loaded.
 */

export const DYNAMIC_NAME = "Dynamic";
export const DYNAMIC_PREFIX = "dynamic:";

export const CATEGORY_IDS = [
  "web_code", "python_code", "code_repair", "code_explain", "planning", "tool_use", "math", "reasoning", "knowledge",
  "instruction", "chat", "creative", "writing", "summarize", "translate_other", "long_context", "vision", "fast"
] as const;
export type TaskCategory = (typeof CATEGORY_IDS)[number];

export const CATEGORY_INFO: Record<TaskCategory, { label: string; hint: string }> = {
  web_code: { label: "Web pages and games", hint: "HTML, CSS, JavaScript, canvas games, small web apps" },
  python_code: { label: "Python and scripts", hint: "Python, shell, data scripts, algorithms" },
  code_repair: { label: "Fixing code", hint: "Errors, tracebacks, bugs, failing tests" },
  code_explain: { label: "Explaining code", hint: "Reading, reviewing and explaining code" },
  planning: { label: "Planning", hint: "Plans, steps, splitting a job into parts" },
  tool_use: { label: "Structured output and tools", hint: "JSON, schemas, extraction, function calls" },
  math: { label: "Math", hint: "Calculations, equations, proofs, word problems" },
  reasoning: { label: "Reasoning and logic", hint: "Puzzles, step-by-step thinking, comparisons" },
  knowledge: { label: "Facts and questions", hint: "Who, what, when, how things work" },
  instruction: { label: "Strict instructions", hint: "Exact formats, lengths and constraints" },
  chat: { label: "Conversation", hint: "Everyday chat, advice, opinions" },
  creative: { label: "Creative writing", hint: "Stories, poems, role-play, lyrics" },
  writing: { label: "Mail and natural writing", hint: "Emails, letters, messages that sound human" },
  summarize: { label: "Summaries and rewriting", hint: "Summarize, rewrite, proofread, shorten" },
  translate_other: { label: "Translation", hint: "Translation and writing in other languages" },
  long_context: { label: "Long documents", hint: "Very long pasted text or files" },
  vision: { label: "Images", hint: "Pictures, screenshots, charts, OCR" },
  fast: { label: "Quick replies", hint: "Greetings, one-line answers, titles" }
};

export const isDynamicId = (id: string | null | undefined): id is string => !!id && id.startsWith(DYNAMIC_PREFIX);
export const tierOf = (id: string) => id.slice(DYNAMIC_PREFIX.length);

// ------------------------------------------------------------------ packs

/**
 * A PC is described by its memory, which fixes how much the NPU can hold. That gives three sizes, named by speed:
 * Flash (the smallest, instant), Flux (the reasonable one), Forge (the biggest the NPU holds). Each size is a PACK:
 * several models of about that size, each the best at one kind of work (code, natural writing, facts, reasoning), and
 * a request goes to the right one of the installed pack.
 */
export const LANES = ["flash", "flux", "forge"] as const;
export type Lane = (typeof LANES)[number];

export const LANE_INFO: Record<Lane, { label: string; hint: string }> = {
  flash: { label: "Flash", hint: "The smallest and fastest: instant answers" },
  flux: { label: "Flux", hint: "The reasonable one: quick enough, good enough" },
  forge: { label: "Forge", hint: "The biggest the NPU holds: best answers, slower" }
};

/** A memory configuration and the pack that is its Flash, its Flux and its Forge. */
export interface Profile { id: string; label: string; ramGB: number; npuGB: number; packs: Record<Lane, string> }

/** One model of a pack. */
export interface BundleModel {
  /** Catalog id, or a short stable name when the model is not in the catalog. */
  ref: string;
  name: string;
  repo: string;
  /** Other repos that hold the same model in the same quant (checked on Hugging Face), tried in order when `repo` fails. */
  altRepos?: string[];
  quant: string | null;
  /** The quant to ask `altRepos` for when `quant` is null because `repo` is a precompiled NPU bundle (which some chips have no build of): a GGUF file of the same model. */
  altQuant?: string;
  paramsB: number;
  sizeGB: number;
  /** What it is for in the pack, in a few words. */
  job: string;
  /** Generation speed: measured by the app on a Snapdragon X NPU, or an estimate (memory bandwidth ÷ file size). */
  tokPerSec: number | null;
  tokEstimated?: boolean;
  /** Always thinks before answering: used for reasoning, maths and plans only. */
  thinking: boolean;
  vision: boolean;
  /** Fits its profile with little room left for context. */
  tight?: boolean;
  /** The repo and its Q4_0 file were checked on Hugging Face. */
  verified: boolean;
  note?: string;
  /** The alias of Microsoft Foundry Local's build of this model, which the pack runs instead when it is installed (it measured faster on the NPU). */
  foundry?: string;
  /** Only Foundry Local has it: there is no file to fetch from anywhere else. */
  foundryOnly?: boolean;
}

/** For each kind of task, the models of the pack in order of preference (refs of its models). */
export type PackTable = Partial<Record<TaskCategory, string[]>>;

export interface Pack {
  id: string;
  /** "4B" */
  label: string;
  maxParamsB: number;
  models: BundleModel[];
  /** The tiny model that sorts the requests of this pack, on the processor. It comes with the pack but is never picked to answer, so it is not in `models`. */
  router?: BundleModel;
  table: PackTable;
  /** Why each pick, "category" → one line with its source. */
  why?: Record<string, string>;
}

export interface DynamicData {
  asOf: string;
  /** What the choices are based on and how far to trust them. */
  provisional?: string;
  profiles: Profile[];
  packs: Record<string, Pack>;
}

export interface DynamicSettings {
  /** The memory configuration chosen; the PC's own when missing. */
  profile?: string;
  /** Choices changed in the developer settings, by pack; they win over the built-in table. */
  table?: Record<string, PackTable>;
  /** When a request cannot be sorted by its words, ask the loaded model (costs a second or two). */
  askModel?: boolean;
  /** The router (a tiny model on the processor) reads the requests the words are unsure about. On when installed, unless this is false. */
  router?: boolean;
  /** The model the router uses (an installed one, small, that runs on the processor); the default one when missing. */
  routerModel?: string;
}

/** The profile that suits a PC with this much memory: the biggest one it can carry. */
export function profileFor(data: DynamicData, ramGB: number | null | undefined, chosen?: string): Profile {
  const byId = data.profiles.find((p) => p.id === chosen);
  if (byId) return byId;
  const fit = [...data.profiles].sort((a, b) => b.ramGB - a.ramGB).find((p) => (ramGB ?? 16) >= p.ramGB - 1);
  return fit ?? data.profiles[0];
}

/** A pack with the developer's changes to its table applied. */
export function mergedPack(data: DynamicData, packId: string, s: DynamicSettings | undefined): Pack | undefined {
  const pack = data.packs[packId];
  return pack ? { ...pack, table: { ...pack.table, ...(s?.table?.[packId] ?? {}) } } : undefined;
}

/** Average speed and total weight of the models of a pack. `speeds` holds what the app measured on this PC. */
export function packStats(pack: Pack, speeds: Record<string, number> = {}): { count: number; tokPerSec: number | null; sizeGB: number } {
  const rates = pack.models.map((m) => speeds[m.ref] ?? m.tokPerSec).filter((x): x is number => typeof x === "number" && x > 0);
  return {
    count: pack.models.length,
    tokPerSec: rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10 : null,
    sizeGB: Math.round(pack.models.reduce((a, m) => a + m.sizeGB, 0) * 10) / 10
  };
}

// ------------------------------------------------------------------ sorting a request

export interface Sorted { category: TaskCategory; confidence: number; reason: string }

export interface SortContext {
  hasImage?: boolean;
  /** Category of the previous request of the chat, for follow-ups like "fix it" or "continue". */
  previous?: TaskCategory;
  /** Files or code already in the chat. */
  hasFiles?: boolean;
}

interface Rule { cat: TaskCategory; re: RegExp; w: number; why: string; onCode?: boolean }

const rule = (cat: TaskCategory, w: number, why: string, re: RegExp, onCode = false): Rule => ({ cat, re, w, why, onCode });

const RULES: Rule[] = [
  // web
  rule("web_code", 3, "mentions a web page", /\b(html5?|css3?|javascript|js\b|typescript|jsx|tsx|react|vue|svelte|tailwind|bootstrap|dom\b|canvas|svg\b|web ?(site|page|app)|site web|page web|landing page|front-?end|responsive|navbar|dropdown|modal|animation css|css animation|flexbox|grid layout)\b/i),
  rule("web_code", 2.5, "asks for a game or interactive page", /\b(snake|tetris|pong|breakout|flappy|2048|memory game|game|calculator|todo|to-do|clicker|quiz app|timer|stopwatch|drawing app|paint app)\b/i),
  rule("web_code", 1.5, "files that run in a browser", /\b[\w-]+\.(html?|css|jsx?|tsx?|vue|svelte)\b/i),
  rule("web_code", 2, "asks to build an interface", /\b(make|build|create|code|write)\b[^.\n]{0,40}\b(page|site|interface|ui\b|button|form(ulaire)?|dashboard|portfolio|menu|widget|app(lication)?)\b/i),
  // python and scripts
  rule("python_code", 3, "mentions Python", /\b(python3?|py\b|pandas|numpy|matplotlib|django|flask|fastapi|pytest|pip install|jupyter|notebook|tkinter|pygame|scipy|sklearn|scikit)\b/i),
  rule("python_code", 2, "mentions another language", /\b(bash|shell script|powershell|rust|golang|go lang|java\b|kotlin|swift|c\+\+|c#|csharp|sql|regex|regexp|node\.?js|sqlite|php|ruby|lua|perl|awk|sed\b)\b/i),
  rule("python_code", 1.8, "asks for an algorithm or a function", /\b(algorithm|leetcode|complexity|big-?o|recursion|sort(ing)? (a )?list|fibonacci|prime numbers?|linked list|binary tree|dynamic programming|function that|script (that|to))\b/i),
  rule("python_code", 1.2, "has a def or a class", /(^|\n)\s*(def |class |import |from \w+ import |#!\/)/, true),
  rule("web_code", 2.5, "describes a game or an animation", /\b(platformer|shooter|arcade|puzzle game|maze|obstacles?|sprite|particles?|bouncing|physics (demo|simulation)|(a|the) game (where|in which)|pomodoro|hover(ed)?|fade|slider|carousel|accordion|tabs? (menu|component)|parallax|scroll(ing)? (effect|animation))\b/i),
  rule("web_code", 3.2, "asks for something interactive", /\b(interactive)\b/i),
  rule("web_code", 2.6, "asks for a simulation or an animation", /\b(visuali[sz]ations?|simulat(?:or|ion)s?|animated)\b/i),
  // a chart of numbers is JSON the app draws (a chart block), so it is structured output, not code: the models best at JSON write it
  rule("tool_use", 4, "asks for a chart the app draws from JSON", /^(?![^]*\b(flow ?charts?|uml|mind ?map|use case|sequence diagram)\b)[^]*\b(diagrams?|charts?|graphs?)\b/i),
  rule("web_code", 2, "wants a website", /\b(website|site internet|site web|homepage)\b/i),
  rule("python_code", 3.2, "scraping or a data program", /\b(scrap(e|ing|er)|beautifulsoup|requests library|selenium|web crawler|crawler|stdin|command[- ]line (tool|program)|cli (tool|app)|reads? (a )?(file|numbers|lines|input)|prints? (the|their)|program that|read(s)? from (a )?file|parse (a )?(csv|log)|automate)\b/i),
  // repairing
  rule("code_repair", 3.5, "reports an error", /\b(traceback|exception|stack ?trace|segfault|undefined is not|is not defined|cannot read propert|syntaxerror|typeerror|referenceerror|nameerror|valueerror|keyerror|indexerror|attributeerror|null ?pointer|compilation error|build failed|error:|does ?n'?t work|not working|bug|crash(es|ed)?|broken)\b/i),
  rule("code_repair", 2, "asks to fix", /\b(fix|debug|repair|why (does|is|do) (this|my|it)[^.\n]{0,40}(fail|crash|error|wrong|not))\b/i),
  rule("code_repair", 3.2, "an error name", /\b(\w+Error|\w+Exception|No module named|command not found|permission denied|segmentation fault|unexpected (token|identifier|end)|expected ['";)}\]]|doesn'?t compile|won'?t compile|returns? (undefined|null|none|nan|nothing)|instead of (the|a|what)|off[- ]by[- ]one|infinite loop|race condition|memory leak)/i),
  // explaining
  rule("code_explain", 3, "asks to explain or review code", /\b(what does (this|that|it) do|walk me through|how does (this|that|the|my) (algorithm|code|function|script|program|class|loop|query|regex) work|explain (this|the|my) (code|function|script|regex|class|snippet)|what does (this|the) (code|function|script|line|regex)|code review|review (my|this) code|refactor|optimi[sz]e (this|my|the) code|add comments|document (this|my) code|write (unit )?tests?)\b/i),
  // planning
  rule("planning", 3, "asks for a plan", /\b(plan|roadmap|step[- ]by[- ]step plan|break (this|it) down|break down|organi[sz]e (my|the|a)|schedule|planning|itinerary|project plan|strategy|architecture (of|for)|design (a|the) system|prioriti[sz]e|checklist|milestones?)\b/i),
  // tool use / structure
  rule("tool_use", 3, "asks for structured output", /\b(json|yaml|xml|csv|schema|structured|function call|tool call|api call|extract (the )?(fields|entities|names|dates|data)|extrais (les )?(dates)|parse (this|the)|convert (this|it) to (json|yaml|xml|csv)|as a table|markdown table)\b/i),
  // math
  rule("math", 1.5, "asks to solve", /\b(solve)\b/i),
  rule("math", 3, "has math in it", /\b(calculate|equation|integral|derivative|limit of|matrix|probability|theorem|prove that|proof|geometry|algebra|trigonometr|sin\(|cos\(|sqrt|percent(age)?|fraction|factori[sz]e|modulo|gcd|how many (ways|combinations))\b/i),
  rule("math", 2, "has a calculation", /(\d+\s*[+\-*/^×÷]\s*\d+|[a-z]\^\d|\b(sin|cos|tan|log|ln|exp)\(|√|\b\d+\s*(%|x)\s*\d+|=\s*\?|\bx\s*=|\bf\(x\))/i),
  // reasoning
  rule("reasoning", 2.5, "asks for logic", /\b(riddle|puzzle|logic|paradox|deduce|infer|brain ?teaser|if all|which is (bigger|better|heavier)|compare and contrast|pros and cons|think (step by step|carefully)|reason (about|through)|trade-?offs?|argue|critique)\b/i),
  // knowledge
  rule("knowledge", 2, "asks a factual question", /\b(who (is|was|were|invented|discovered|wrote)|what (is|are|was|were) (the|a|an)|when (did|was|were|is)|where (is|was|are)|how (does|do|did) .{0,30} work|capital of|history of|why is the|define|definition|meaning of|difference between)\b/i),
  rule("math", 2.5, "numbers in a question", /(?=(?:[^\d]*\d){2})[^]*\b(how (many|much|long|far|fast|old)|when (do|will|would)|what (is|are) the (total|sum|average|mean|median|product|difference|ratio|rate|speed|area|volume|perimeter)|at what (time|speed)|km\/h|mph|per (hour|minute|day|cent))\b/i),
  rule("math", 2.8, "a computation", /\b(compute|add|subtract|multiply|divide)\b[^.\n]{0,40}\d|\d+\s*%\s*(of)\s*\d+|\b(average|mean|median) of\b[^.\n]{0,30}\d/i),
  rule("reasoning", 2.5, "a dilemma", /\b(ethic(al|s)?|moral(ly)?|dilemma|both sides|should i|is it (right|wrong|ok|okay|fair|true) (to|that)|what would happen if|hypothetical|counterfactual)\b/i),
  // instruction following
  rule("instruction", 2.8, "gives exact constraints", /\b((reply|answer|respond) (with )?only|only the word|yes or no|each (sentence|line|word|paragraph) (starting|beginning|ending|with)|exactly|no more than|at (least|most)|in (exactly )?\d+ (words|sentences|bullet|points|lines|paragraphs)|only (reply|answer|output|respond)|without (using|the word)|do not (mention|use|include)|use (only|the format)|format(ted)? as|start (with|each)|end with|all caps|lowercase|in the style of)\b/i),
  rule("knowledge", 1.2, "starts like a question", /^\s*(who|what|when|where|why|how|which|whose)\b[^.]{0,120}\?\s*$/i),
  rule("knowledge", 2.4, "asks how or why something is", /\b(explain (how|why|what|the)|what (causes|makes|happens)|how (do|does|did|can|is|are) (?!you say|you pronounce|would you say)\w+|why (do|does|did|are|is) \w+|tell me about|who (painted|wrote|composed|founded|built|discovered|invented|directed|won|created|discovered)|how (old|tall|big|far|long) is)\b/i),
  // creative
  rule("creative", 3, "asks for creative writing", /\b(tell me a (joke|story|riddle|pun|fairy tale)|bedtime story|story|short story|poem|poetry|haiku|sonnet|lyrics|song|rap\b|novel|fiction|fan ?fic|screenplay|scenario|dialogue between|character|role-?play|pretend (you|to be)|act as (a|an|if)|villain|dragon|wizard|once upon|write (me )?a (joke|riddle|pun))\b/i),
  // a mail or a message that has to sound human
  rule("writing", 3.4, "asks for a mail, a letter or a message", /(write|draft|compose)\b[^.\n]{0,40}\b(an? |my )?(e-?mail|mail|letter|message|cover letter|linkedin|speech|invitation|thank[- ]you|announcement|apology|resignation|reply|post)\b/i),
  rule("writing", 3.4, "wants it to sound natural", /\b(sound(s)? (more )?(natural|human|friendly|polite|warm|professional|formal)|more (natural|human|friendly|polite|warm|formal))\b/i),
  // summarizing / rewriting
  rule("summarize", 3, "asks to condense or rewrite", /\b(make (this|it|that|the) (paragraph|text|sentence|email|message|note|description)[^.\n]{0,15}(shorter|longer|clearer|simpler|better|more \w+)|(shorter|more concise)\b|give me the (key points|main points|gist)|the gist|summari[sz]e|summary|tl;?dr|shorten|rewrite|paraphrase|proofread|fix (the )?(grammar|spelling|typos)|make (it|this) (shorter|clearer)|improve (my|this) (text|email|writing|essay)|key points|bullet points? (of|from)|condense|simplify (this|the) text)\b/i),
  // translation
  rule("translate_other", 3.9, "translation to another language", /\b(how (do|would) you say|how to say|translate|translation|in (english|arabic))\b/i),
  // vision
  rule("vision", 3, "talks about an image", /\b(this (image|picture|photo|screenshot|screen ?shot|chart|graph|diagram)|in the (image|picture|photo|screenshot)|what('s| is) (in|on) (the|this) (image|picture|photo|screen)|ocr|read the text (in|from)|describe (the|this|my) (image|picture|photo|screenshot|diagram|chart)|(screenshot|image|picture|photo|diagram|chart|capture)( that)? (i|I) (sent|attached|uploaded))\b/i),
  // chat
  rule("chat", 2.4, "talks to the assistant", /\b(your (favou?rite|opinion|view|take)|what do you (think|like|prefer)|do you (like|prefer|believe|think)|i had a (rough|bad|great|long) |i need to vent|i feel|i'm (sad|tired|bored|stressed|anxious|happy)|advice|what do you think|recommend|suggest|suggestion|opinion|how are you|tell me about yourself)\b/i),
  // quick
  rule("fast", 3, "a greeting or a one-liner", /^\s*(hi|hello|hey|yo|thanks|thank you|ok(ay)?|cool|bye|good (morning|night|evening)|test|ping|\?|lol)[\s!.?]*$/i)
];

/** Arabic script means an Arabic request. */
const NON_LATIN = /[\u0600-\u06ff]/;

/** Long pasted text (a document) is a different job from a question about it. */
export const LONG_TEXT_CHARS = 9000;

/**
 * Sorts a request by its words, its shape and what the chat already holds. No model is involved, so it is instant and
 * the same every time. `confidence` (0 to 1) tells whether a model should be asked to look at the request as well.
 */
export function sortRequest(text: string, ctx: SortContext = {}): Sorted {
  const t = text.trim();
  if (ctx.hasImage) return { category: "vision", confidence: 0.95, reason: "an image is attached" };
  if (!t) return { category: ctx.previous ?? "chat", confidence: 0.3, reason: "an empty message" };
  if (t.length >= LONG_TEXT_CHARS) {
    // a long text with a short instruction on top: the instruction says what to do, the length says where to read
    const head = sortRequest(t.slice(0, 600), ctx);
    return { category: head.confidence >= 0.7 && head.category !== "chat" && head.category !== "knowledge" ? head.category : "long_context", confidence: 0.8, reason: "a very long text" };
  }
  const score = new Map<TaskCategory, { s: number; why: string }>();
  const add = (cat: TaskCategory, w: number, why: string) => { const cur = score.get(cat); score.set(cat, { s: (cur?.s ?? 0) + w, why: cur && cur.s >= w ? cur.why : why }); };
  // the words are read outside fenced code (a `python` inside a block says what the code is, not what is asked)
  const prose = t.replace(/```[\s\S]*?(```|$)/g, " [code] ");
  for (const r of RULES) {
    const m = (r.onCode ? t : prose).match(r.re);
    if (m) add(r.cat, r.w * (m.length > 1 && r.re.global ? 1.2 : 1), r.why);
  }
  // shape: code in the message
  const fences = (t.match(/```/g) ?? []).length / 2;
  if (fences >= 1) {
    const lang = /```(\w+)/.exec(t)?.[1]?.toLowerCase() ?? "";
    const asked = score.has("code_repair") || score.has("code_explain");
    if (!asked && /^(html|css|js|javascript|jsx|ts|tsx|typescript|vue|svelte)$/.test(lang)) add("web_code", 2.5, "web code in the message");
    else if (!asked && lang) add("python_code", 2.5, `${lang} code in the message`);
    if (!score.has("code_repair") && !score.has("code_explain") && !score.has("web_code")) add("code_explain", 1.2, "code in the message");
  }
  // language: a script that is not Latin goes to the translation model
  if (NON_LATIN.test(t) && !score.has("translate_other")) add("translate_other", 2, "written in another language");
  if (t.length < 24 && !score.size) add("fast", 2, "a very short message");
  else if (t.length < 60 && !score.size) add("chat", 1.1, "a short message");
  // a short follow-up keeps the topic of the one before ("fix it", "continue", "shorter")
  const words = t.split(/\s+/).length;
  if (ctx.previous && words <= 7 && (!score.size || Math.max(...[...score.values()].map((v) => v.s)) < 2.5)) add(ctx.previous, 3, "a follow-up to the previous request");
  // code files in the chat make an ambiguous "make it better" a code job
  if (ctx.hasFiles && /\b(better|improve|add|change|update|make it|change)\b/i.test(t) && !score.has("web_code") && !score.has("python_code")) add(ctx.previous && /code|repair/.test(ctx.previous) ? ctx.previous : "web_code", 2, "a change to the files of the chat");
  if (!score.size) return { category: "chat", confidence: 0.35, reason: "nothing specific found" };
  const ranked = [...score.entries()].sort((a, b) => b[1].s - a[1].s);
  let [cat, top] = ranked[0];
  // an exact format or length is the job when the topic is only a question or a chat
  if ((cat === "knowledge" || cat === "chat") && (score.get("instruction")?.s ?? 0) >= 2.5) { cat = "instruction"; top = score.get("instruction")!; }
  const second = ranked.find(([c]) => c !== cat)?.[1].s ?? 0;
  const confidence = Math.max(0.2, Math.min(0.98, (top.s / (top.s + second + 1)) * (top.s >= 3 ? 1.15 : top.s >= 2 ? 1 : 0.75)));
  return { category: cat, confidence: Math.round(confidence * 100) / 100, reason: top.why };
}

/** The question to a model when the words were not enough: it answers with one id. */
export function sortPrompt(text: string): { system: string; user: string } {
  const list = CATEGORY_IDS.filter((c) => c !== "fast").map((c) => `${c}: ${CATEGORY_INFO[c].hint}`).join("\n");
  return {
    system: `You sort requests. Reply with exactly one word from this list and nothing else:\n${list}\nfast: a greeting or a one-line answer`,
    user: `Request:\n${text.trim().slice(0, 1200)}\n\nWhich one is it?`
  };
}

/** The category in a model's reply, or null. */
export function parseSort(reply: string): TaskCategory | null {
  const w = reply.toLowerCase().match(/[a-z_]+/g) ?? [];
  return (w.find((x) => (CATEGORY_IDS as readonly string[]).includes(x)) as TaskCategory | undefined) ?? null;
}

// ------------------------------------------------------------------ choosing a model

const norm = (s: string) => s.trim().toLowerCase();
const refOf = (e: Pick<CatalogEntry, "repo" | "quant">) => (e.quant ? `${e.repo}:${e.quant}` : e.repo);

/** Does this entry answer to a name (its id, its repo, repo:quant, its name, or the same name written loosely)? */
const looseKey = (s: string) => s.toLowerCase().replace(/^.*\//, "").replace(/:.*$/, "").replace(/[-_ ]?gguf$/, "").replace(/[^a-z0-9.]+/g, "");
export function entryMatches(e: CatalogEntry, want: string): boolean {
  const w = norm(want);
  if (norm(e.id) === w || norm(e.repo) === w || norm(refOf(e)) === w || norm(e.name) === w) return true;
  const k = looseKey(want);
  return k.length >= 5 && (looseKey(e.name) === k || looseKey(e.repo) === k);
}

/** The installed entry of a pack model, if any. */
/** A bigger build of the same model (Q8_0 for Q4_0) is not the pack's model: it needs twice the NPU memory. */
const sameQuant = (e: CatalogEntry, m: BundleModel) => !m.quant || !e.quant || e.quant.toLowerCase() === m.quant.toLowerCase();
export const installedOf = (m: BundleModel, installed: CatalogEntry[]): CatalogEntry | undefined => {
  // the Foundry Local build comes first when it is there: that is the one the pack measured faster
  const f = m.foundry ? installed.find((e) => e.id === `foundry:${m.foundry}`) : undefined;
  if (f || m.foundryOnly) return f;
  return installed.find((e) => !e.id.startsWith("foundry:") && sameQuant(e, m) && (e.dynamicRef === m.ref || entryMatches(e, m.ref) || entryMatches(e, m.repo) || entryMatches(e, m.name)));
};

export interface Choice {
  entry: CatalogEntry;
  model: BundleModel;
  category: TaskCategory;
  /** The model the pack wanted first, when it was not the one used (not installed). */
  wanted: string | null;
  /** Why `wanted` was left out although it is installed: it does not fit this PC's NPU memory, or it always thinks. null = not installed. */
  skipped?: "fit" | "thinks" | null;
  /** Where in the pack's list the pick was found: 0 = first choice. */
  rank: number;
}

/** The kinds of task where thinking before answering pays. For the others a model that always thinks is left out. */
export const THINKING_OK = new Set<TaskCategory>(["reasoning", "math", "planning"]);

/** Small talk and short answers do not deserve a model switch: whatever pack model is loaded answers. */
const STAY = new Set<TaskCategory>(["fast", "chat"]);

export interface PickOptions {
  loaded?: CatalogEntry | null;
  /** Whether a model fits this machine's NPU memory. Models that do not are skipped while another one of the pack does. */
  fits?: (e: CatalogEntry) => boolean;
}

/**
 * The model for one kind of task, among the INSTALLED models of the pack: the first of the pack's list for it. A model that
 * always thinks is only used for reasoning, maths and plans. For small talk the loaded model of the pack answers, to spare a
 * load. With nothing suitable the loaded model of the pack, then the first one. null when no model of the pack is installed.
 */
export function pickModel(pack: Pack, category: TaskCategory, installed: CatalogEntry[], opts: PickOptions = {}): Choice | null {
  let have = pack.models.flatMap((m) => { const e = installedOf(m, installed); return e ? [{ m, e }] : []; });
  if (!have.length) return null;
  const installedRefs = new Set(have.map((x) => x.m.ref));
  const dropped = new Map<string, "fit" | "thinks">();
  if (opts.fits) { const ok = have.filter((x) => opts.fits!(x.e)); if (ok.length) { have.filter((x) => !ok.includes(x)).forEach((x) => dropped.set(x.m.ref, "fit")); have = ok; } }
  if (!THINKING_OK.has(category)) { const calm = have.filter((x) => !x.m.thinking && thinkingSupport(x.e) !== "always"); if (calm.length) { have.filter((x) => !calm.includes(x)).forEach((x) => dropped.set(x.m.ref, "thinks")); have = calm; } }
  const list = pack.table[category] ?? pack.table.chat ?? [];
  const first = pack.models.find((m) => m.ref === list[0]);
  // the first choice may be installed yet left out: that is not "not installed"
  const skipped = first && installedRefs.has(first.ref) ? dropped.get(first.ref) ?? null : null;
  const here = opts.loaded ? have.find((x) => x.e === opts.loaded) : undefined;
  if (STAY.has(category) && here) return { entry: here.e, model: here.m, category, wanted: null, rank: 0 };
  for (let rank = 0; rank < list.length; rank++) {
    const x = have.find((h) => h.m.ref === list[rank]);
    if (x) return { entry: x.e, model: x.m, category, wanted: rank > 0 ? first?.name ?? null : null, skipped: rank > 0 ? skipped : null, rank };
  }
  const any = here ?? have[0];
  return { entry: any.e, model: any.m, category, wanted: first?.name ?? null, skipped, rank: list.length };
}

/** The note on a pick that is not the pack's first choice, saying the true reason. */
export const wantedNote = (c: Pick<Choice, "wanted" | "skipped">) =>
  !c.wanted ? "" : ` (${c.wanted} would be better, ${c.skipped === "fit" ? "it is installed but does not fit this PC's NPU memory" : c.skipped === "thinks" ? "it is installed but always thinks, too slow for this" : "it is not installed"})`;

/** Is this repo a precompiled NPU bundle (its context window is compiled into the graph) rather than a GGUF file (whose window is configured at serve time)? */
const bundleRepo = (repo: string) => /^(ai-hub-models|qualcomm)\//i.test(repo);

/** The kind of artifact an entry holds, from the entry ITSELF (its engine, then its repo) — never from the pack member it was matched to. */
const entryKind = (e: Pick<CatalogEntry, "engine" | "repo">): "bundle" | "gguf" => (e.engine === "qairt" || bundleRepo(e.repo) ? "bundle" : "gguf");

/**
 * Entries saved by an older version may carry a size that counted a quant twice (whole file plus its shards). A saved pack model
 * far above the size its pack records is put back to that size, so it is not refused as too big for the NPU.
 * Independently of the size repair, the entry's context is clamped to what its MATCHED ARTIFACT can serve — and only when the
 * matched artifact is the SAME KIND as the entry, because neither kind bounds the other: a QAIRT bundle's window is compiled in
 * (its read window, else the usual 4096 estimate), a GGUF file's window is configured at serve time (the estimator's 8192 tier).
 * A GGUF entry matched to a GGUF member is capped only when the pairing is that member's own file — its repo or one of the
 * pack's alt repos, or the ref the pack saved — never on a loose name alone. Every clamp is a cap, never raised. Without
 * compiled evidence the caps stand, and the caller should say the number is an estimate.
 * `refit` repairs what an older version already lowered and saved: a GGUF entry matched to a QAIRT member whose saved context is
 * exactly that clamp's fingerprint (the usual 4096, or the member's known compiled window) is re-derived the way an install does
 * it — min(the GGUF file's own trained window, the 16384 serve ceiling), fitted to this machine's NPU memory — when the caller
 * can read the file and measure that fit; null or no `refit` leaves the saved value as it is. A QAIRT entry is never raised,
 * and the refit is only ever offered to a GGUF entry. The repair is computed in memory on every load and never saved: the
 * entry on disk keeps what it has, so the number is re-derived from the file it names each time the app starts.
 */
export function healEntry(e: CatalogEntry, models: BundleModel[], compiled?: CompiledEvidence, refit?: (e: CatalogEntry) => number | null): CatalogEntry {
  const m = models.find((x) => e.dynamicRef === x.ref || entryMatches(e, x.ref) || entryMatches(e, x.repo) || entryMatches(e, x.name));
  if (!m) return e;
  const eBundle = entryKind(e) === "bundle", mBundle = bundleRepo(m.repo);
  // the routed artifact's own effective limit decides the cap — the size repair does not
  const ownFile = e.dynamicRef === m.ref || e.repo === m.repo || (m.altRepos ?? []).some((r) => r.toLowerCase() === e.repo.toLowerCase());
  const cap = eBundle === mBundle && (eBundle || ownFile) ? memberContext(m, compiled).tokens : null;
  // the old clamp's fingerprint on a GGUF entry paired with a bundle member: the saved number can only have come from it
  const seen = saneWindow(compiled?.(m));
  const lowered = !eBundle && mBundle && (e.recommendedContext === QAIRT_USUAL_CTX || (seen !== null && e.recommendedContext === seen));
  const refitted = lowered && refit ? refit(e) : null;
  const recommendedContext = refitted ?? (cap !== null ? Math.min(e.recommendedContext, cap) : e.recommendedContext);
  const repair = !!m.sizeGB && e.sizeGB > m.sizeGB * 1.25 && sameQuant(e, m);
  if (!repair && recommendedContext === e.recommendedContext) return e;
  return { ...e, ...(repair ? { sizeGB: m.sizeGB } : {}), recommendedContext };
}

/** Where to get a pack model, in order: its own repo, then the other providers of the same file. */
export const candidateRepos = (m: BundleModel): string[] => (m.foundryOnly ? [] : [m.repo, ...(m.altRepos ?? [])]).filter((r, i, all) => all.indexOf(r) === i);

/** Everything a pack installs: the models that answer, and its router. */
export const packParts = (pack: Pack): BundleModel[] => (pack.router ? [...pack.models, pack.router] : pack.models);

/** The models of a pack that are not installed yet. */
export const missingInPack = (pack: Pack, installed: CatalogEntry[]) => pack.models.filter((m) => !installedOf(m, installed));

// ------------------------------------------------------------------ the entry in the model list

const DYNAMIC_SAMPLING: Sampling = { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 1.5, max_tokens: 4096 };

/**
 * The compiled window of one installed artifact, when the caller has read it (the main process reads
 * the bundle's genie_config.json; the renderer receives the same truth over the bridge). Renderer-safe:
 * this module never touches the file system itself.
 */
export type CompiledEvidence = (m: BundleModel) => number | null;

/** What one QAIRT artifact's window is known to be: the read compiled window, or null when its bundle was not read (or says nothing). */
export interface ArtifactContext { repo: string; compiled: number | null }

/**
 * The pack's context and exactly where it came from, per artifact. `measured` is true only when
 * EVERY QAIRT artifact of the pack carries read evidence — one known artifact must not speak for
 * the others (an unread bundle may compile to a smaller window).
 */
export interface PackContextInfo {
  tokens: number;
  measured: boolean;
  /** Evidence coverage over the pack's QAIRT artifacts; null when the pack has none (GGUF-only). */
  coverage: { known: number; total: number } | null;
  /** Per-artifact provenance for the pack's QAIRT artifacts. */
  artifacts: ArtifactContext[];
  why: string;
}

/** The compiled window a QAIRT bundle is USUALLY built with — the conservative stand-in for one that was not read. */
export const QAIRT_USUAL_CTX = 4096;

/** The largest context a GGUF model is served with: an install caps the file's own trained window at this, and so does the
 * repair of an entry an older version lowered. */
export const GGUF_CONTEXT_CEILING = 16384;

/** The context an install wants for a GGUF file: the window the file itself was trained with, capped at the serve ceiling.
 * null when the file's window is unknown: nothing is then changed, the saved value stands. */
export const refitWanted = (fileWindow: number | null): number | null =>
  fileWindow === null ? null : Math.min(fileWindow, GGUF_CONTEXT_CEILING);

const saneWindow = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/** The pack's QAIRT artifacts with their compiled windows (null = unknown: not read, or the caller passed no evidence). */
const artifactWindows = (pack: Pack, compiled?: CompiledEvidence): ArtifactContext[] =>
  pack.models
    .filter((m) => /^ai-hub-models\//i.test(m.repo))
    .map((m) => ({ repo: m.repo, compiled: saneWindow(compiled?.(m)) }));

/**
 * The context a pack can serve, from the artifacts it actually holds — never one number for all packs.
 * With compiled evidence the SMALLEST window wins (the binding constraint: the pack must serve every
 * request with one of its models); a QAIRT artifact WITHOUT evidence is conservatively taken at the
 * usual 4096 estimate, so partial evidence lowers the number but never claims the pack
 * is measured — `measured` stays false until every artifact was read. A pack of GGUF models has no
 * compiled limit (the window is configured at serve time): the estimator's top tier (8192). Prefer
 * `packContextDetail` at the call sites that can label the number.
 */
export const packContext = (pack: Pack, compiled?: CompiledEvidence): number => packContextDetail(pack, compiled).tokens;

/** The same number as `packContext`, but honest about where it came from, per artifact. */
export const packContextDetail = (pack: Pack, compiled?: CompiledEvidence): PackContextInfo => {
  const arts = artifactWindows(pack, compiled);
  if (!arts.length) return { tokens: 8192, measured: false, coverage: null, artifacts: [], why: "an estimate: the estimator's top context tier for GGUF models" };
  const known = arts.filter((a) => a.compiled !== null);
  const unknown = arts.filter((a) => a.compiled === null);
  // conservative: an artifact that was not read is ASSUMED to compile to the usual window — never to something bigger
  const vals = [...known.map((a) => a.compiled!), ...unknown.map(() => QAIRT_USUAL_CTX)];
  const tokens = Math.min(...vals);
  if (!unknown.length) {
    return {
      tokens, measured: true, coverage: { known: known.length, total: arts.length }, artifacts: arts,
      why: `the compiled window${known.length > 1 ? "s" : ""} of all ${arts.length} installed QAIRT bundle${arts.length > 1 ? "s" : ""} (${known.map((a) => a.compiled).join(", ")})`,
    };
  }
  const missing = unknown.map((a) => a.repo).join(", ");
  return {
    tokens, measured: false, coverage: { known: known.length, total: arts.length }, artifacts: arts,
    why: known.length
      ? `partly measured: the compiled windows of ${known.length} of ${arts.length} QAIRT artifacts (${known.map((a) => a.compiled).join(", ")}); ${missing} ${unknown.length > 1 ? "were" : "was"} not read here and ${unknown.length > 1 ? "are" : "is"} taken at the usual ${QAIRT_USUAL_CTX} estimate — the pack's real floor may be lower`
      : `an estimate: the usual compiled window of a QAIRT bundle (none of ${arts.length} ${arts.length > 1 ? "bundles were" : "bundle was"} read here)`,
  };
};

/**
 * The effective context of a request routed to ONE concrete pack member: that artifact's own compiled
 * window when it was read (measured); otherwise the conservative stand-in for its kind, labelled an
 * estimate. A served status's `servedNctx`, when the server reports one, stays the observed truth
 * above this.
 */
export const memberContext = (m: BundleModel, compiled?: CompiledEvidence): { tokens: number; measured: boolean; why: string } => {
  const known = saneWindow(compiled?.(m));
  if (known !== null) return { tokens: known, measured: true, why: `the compiled window of ${m.repo}'s installed bundle` };
  return /^ai-hub-models\//i.test(m.repo)
    ? { tokens: QAIRT_USUAL_CTX, measured: false, why: `an estimate: the usual compiled window of a QAIRT bundle (${m.repo}'s was not read here)` }
    : { tokens: 8192, measured: false, why: "an estimate: the estimator's top context tier for GGUF models" };
};

/** The virtual model shown in the list: nothing to download itself, it stands for its pack. `lane` names it for the PC's profile.
 *  `compiled` is the per-artifact evidence when the caller has it: the entry's window is then the pack's measured floor. */
export function dynamicEntry(pack: Pack, lane?: Lane, compiled?: CompiledEvidence): CatalogEntry {
  const ctx = packContext(pack, compiled);
  return {
    id: `${DYNAMIC_PREFIX}${pack.id}`, name: `${DYNAMIC_NAME} ${lane ? `${LANE_INFO[lane].label} ` : ""}${pack.label}`, repo: `${DYNAMIC_PREFIX}${pack.id}`, quant: null, engine: "llama_cpp",
    role: `The best ${pack.label} model for each request`, architecture: "dynamic", sizeGB: 0, sizeApprox: true, paramsB: pack.maxParamsB,
    recommendedContext: ctx, sampling: { ...DYNAMIC_SAMPLING, max_tokens: ctx }
  } as CatalogEntry;
}
