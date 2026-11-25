import { CATEGORY_IDS, type BundleModel, type Sorted, type TaskCategory } from "./dynamic";
import type { TemplateKind } from "./templates/kit";

/**
 * The first look at a request, the way a person decides in a blink before thinking: a very small model that does only this. The rules in
 * dynamic.ts decide most requests in no time; when they hesitate, this model reads the request and names its kind in one word. It runs on
 * the processor in a server of its own, never on the NPU (which holds a single model, and swapping it for every request would cost more
 * than the answer), so it is always there. No training: the categories and a few examples in its instructions are all it needs.
 */

/** A GenieX models list ({ data: [{ id: "repo:quant", object: "model" }] }: GenieX lists the
 *  models of this PC's cache) that holds one of the models this app may use as its router
 *  (`refs`, each "repo:quant" or a bare repo; the default is the router model's own repos):
 *  the only kind of server the router adopts on its port. */
export function servesRouterModel(models: unknown, refs?: string[]): boolean {
  const data = (models as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return false;
  const want = (refs && refs.length ? refs : [ROUTER_MODEL.repo, ...(ROUTER_MODEL.altRepos ?? [])]).map((r) => r.toLowerCase());
  return data.some((m) => {
    const id = (m as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return false;
    const full = id.toLowerCase();
    return want.some((w) => (w.includes(":") ? full === w : full.split(":")[0] === w));
  });
}

export const ROUTER_MODEL: BundleModel = {
  ref: "qwen3-0.6b",
  name: "Qwen3-0.6B",
  repo: "unsloth/Qwen3-0.6B-GGUF",
  altRepos: ["bartowski/Qwen_Qwen3-0.6B-GGUF"],
  quant: "Q4_0",
  paramsB: 0.6,
  sizeGB: 0.4,
  job: "sorts each request into its kind, on the processor",
  tokPerSec: null,
  thinking: false,
  vision: false,
  verified: true,
  note: "The router of the Dynamic model: runs on the processor (the graphics processor when the processor is too busy), not on the NPU."
};

/**
 * How the router is sampled: greedy, with nothing of the chat's own settings (a presence penalty of 1.5 on a one-word answer, or a top-k, made the same question answer differently from one run to the next:
 * the lab's runs of one prompt went from right to wrong at random, the 0.6B model scored below chance, and the 2B right 60 to 80 % of the time on a question it answered right on its best run).
 */
export const routerSampling = (maxTokens: number) => ({ temperature: 0, top_p: 1, top_k: 1, max_tokens: Math.max(ROUTER_MIN_TOKENS, maxTokens) });

/** Room for a thinking block some models write before their word (the lab clamps its own cap to 16 tokens). It was suspected of making the router answer nothing; the lab runs showed it does not: the empty replies have another cause. */
export const ROUTER_MIN_TOKENS = 12;

/** The router measured on the hard requests of `docs/prompt-lab/prompt-lab-router.md` (best run of each prompt, mean of 102): Qwen3.5-2B 95.7, Qwen3-1.7B native bundle 84.5, Qwen3-1.7B 70.7, LFM2-1.2B-Tool 47.4, Qwen3-0.6B 38.8 (below chance). The 2B is used when it is installed (the voice pack installs it) and nothing else is chosen. */
export const ROUTER_PREFERRED = /qwen3\.5[-_ ]?2b/i;

/** Where its own server listens (the chat's is on 18181), and the window it is given: the prompt is short and the answer is one word. */
export const ROUTER_HOST = "127.0.0.1:18182";
export const ROUTER_CTX = 2048;
/** The rules are trusted above this; below it the request is read by the router. */
export const ROUTER_BELOW = 0.8;
/** The whole sort is done in this time or the rules' guess stands: sorting must never be what makes an answer wait. A model that answers each question in 0.3 s sorts in about a second. */
export const ROUTER_TIMEOUT_MS = 2000;

/**
 * How long the router breaker stays open after a question went unanswered. The rule the
 * on-device test runs broke: a router that times out costs at most its short timeout ONCE per
 * request — but every closed question of a build gate, a file kind, identity or recall
 * carried its own fresh timeout, so a wedged router (one that accepts the connection and
 * never answers, exactly the state the adopted 18182 server reached mid-run) cost one
 * request ten timeouts and more. Long enough to cover the closed questions of one
 * request; the next request after it meets the router fresh, and the background warm
 * closes the breaker earlier when the router answers again.
 */
export const ROUTER_BREAKER_MS = 30_000;

/**
 * Holds the rule above: after one failure the breaker is open, the questions that follow
 * are refused without reaching the server (the words' guess stands, the established
 * degradation), and a success closes it. The clock is injectable so tests do not wait.
 */
/** Consecutive misses (no answer in time) of a WARMED router that move it from the CPU to the GPU. */
export const ROUTER_GPU_AFTER = 2;
export type RouterCompute = "cpu" | "gpu";

/**
 * Where the router runs: on the CPU first, the GPU when the CPU is too busy. Measured
 * on GenieX 0.11.0: the CPU router answers in 39-274 ms on a calm PC, but its 18 spinning threads collapsed to
 * 0.06 tokens/s while other programs kept the CPU at 60-100 %; the GPU answers in about 120 ms either way. Once on
 * the GPU it stays there for the session (no flapping); a new start of the app begins on the CPU again.
 */
export class RouterPlacement {
  compute: RouterCompute = "cpu";
  reason: string | null = null;
  private misses = 0;
  /** A warmed router did not answer in time. True when it must move to the GPU now. */
  missed(): boolean {
    if (this.compute === "gpu") return false;
    this.misses++;
    if (this.misses < ROUTER_GPU_AFTER) return false;
    this.compute = "gpu";
    this.misses = 0;
    this.reason = `the router on the processor did not answer in time ${ROUTER_GPU_AFTER} times in a row (the processor was busy): it moved to the graphics processor`;
    return true;
  }
  /** The router answered: a single slow answer is not a busy processor. */
  answered(): void { this.misses = 0; }
}

/** Where the router runs, in the words the Router panel shows. */
export const routerWhere = (c: RouterCompute | string | null | undefined): string =>
  c === "gpu" ? "runs on the graphics processor (the processor was too busy), not on the NPU" : "runs on the processor, not on the NPU";

export class RouterBreaker {
  private openUntil = 0;
  /** True while the questions must not reach the server. */
  isOpen(now = Date.now()): boolean { return now < this.openUntil; }
  /** One question failed or timed out: refuse the rest of the request's questions. */
  trip(now = Date.now()): void { this.openUntil = Math.max(this.openUntil, now + ROUTER_BREAKER_MS); }
  /** The router answered: the next request meets it fresh. */
  close(): void { this.openUntil = 0; }
}

/**
 * The router's server says "ready" about 0.6 s after it is spawned — with NO model loaded
 * (its /v1/models lists the whole runtime cache and its /health says ok); the model's
 * first load takes about 3.5 s, and every ask of that window burns the whole router
 * timeout and trips the breaker for a silence that was never the router's fault. The
 * gate refuses the asks until the model has answered ONCE on the current server (the
 * warm question), and resets whenever the server changes under it (a respawn, or a new
 * adoption, loads the model again).
 */
export class RouterWarmGate {
  private warmed = false;
  /** True while the questions may reach the server. */
  get open(): boolean { return this.warmed; }
  /** The warm question was answered: the server's model is loaded. */
  markWarmed(): void { this.warmed = true; }
  /** The server changed or went down: whatever is listening next must load first. */
  reset(): void { this.warmed = false; }
}

/** The shortest idle window the router is given: one request's closed questions must never meet a stopped router. */
export const ROUTER_IDLE_MIN_MS = 60_000;

/**
 * Stops the router's server after the user's idle window (`idleReleaseSec`; 0 keeps it ready). It
 * held about 850 MB for 24 hours after one request. The whole process is stopped, not only the
 * model unloaded, so the warm gate always knows: the owner resets the gate before the stop, and
 * the next request is refused by the gate (the words decide) while a warm-up starts the server
 * again. It is never a miss, so it never moves the router to the GPU. `begin`/`end` bracket every
 * use (a question, a sort, a warm-up); no release happens while one runs. Nor while another
 * instance that adopted this server is using it (`othersActive`, see RouterUsers): the window
 * then starts again. The window is read again at least every ROUTER_IDLE_CHECK_MS while the
 * router is idle: nothing tells the sidecar when the setting changes (the window saves it
 * through the host), and a change must apply without waiting for another use.
 */
export class RouterIdleRelease {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = 0;
  /** When the current idle window started: the end of the last use, or a deferral. */
  private idleFrom = 0;
  constructor(private idleMs: () => number, private release: () => void, private othersActive: () => boolean = () => false) {}
  /** How many uses are running now. */
  get running(): number { return this.busy; }
  /** A use starts: no release until it ends. */
  begin(): void { this.busy++; this.cancel(); }
  /** A use ended: the idle window starts again from now. */
  end(): void {
    this.busy = Math.max(0, this.busy - 1);
    if (this.busy === 0) { this.idleFrom = Date.now(); this.arm(); }
  }
  /** No release is due (the server was stopped for another reason). */
  cancel(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  /** How long until the release is due under the setting as it is now; null while it says "keep it ready". */
  private dueIn(): number | null {
    const ms = this.idleMs();
    if (!(ms > 0)) return null;
    return Math.max(0, this.idleFrom + Math.max(ms, ROUTER_IDLE_MIN_MS) - Date.now());
  }
  private arm(): void {
    this.cancel();
    const due = this.dueIn();
    this.timer = setTimeout(() => this.tick(), Math.min(due ?? ROUTER_IDLE_CHECK_MS, ROUTER_IDLE_CHECK_MS));
    (this.timer as { unref?: () => void }).unref?.();
  }
  private tick(): void {
    this.timer = null;
    if (this.busy !== 0) return;
    const due = this.dueIn();
    if (due === null || due > 0) { this.arm(); return; } // not due under the current setting: look again
    if (this.othersActive()) { this.idleFrom = Date.now(); this.arm(); return; } // another instance uses this server: wait another window
    this.release();
  }
}

/** The longest the idle release waits before it reads the setting again. */
export const ROUTER_IDLE_CHECK_MS = 60_000;

/**
 * Runs the router's warm-up one at a time. A plain request made while one runs is dropped (that
 * one will do), but a FORCED one is kept and run once more when it ends: the server it warms may
 * have been stopped and replaced meanwhile (routerMissed moves the router to the GPU while the
 * warm-up the timeout started is still out), and dropping it left the new server cold until
 * another request came. Several forced requests made during one run still give one re-run.
 */
export class WarmUp {
  private running = false;
  private queued: (() => Promise<void>) | null = null;
  /** True while a warm-up runs. */
  get busy(): boolean { return this.running; }
  /** Runs `task` now, or, when one is running and `force` is set, once that one ends. A failure is the task's own to report. */
  start(task: () => Promise<void>, force = false): void {
    if (this.running) { if (force) this.queued = task; return; }
    this.running = true;
    void task().catch(() => undefined).finally(() => {
      this.running = false;
      const next = this.queued;
      this.queued = null;
      if (next) this.start(next);
    });
  }
}

/**
 * What the file-kind question answered for one message text. A question without an
 * answer is NOT an outcome: the cold, gated or wedged router's null must not stand in
 * for "no file is wanted" on every later ask of the same text (the live probe of the
 * warm gate caught a cold call poisoning the memory). Only a real outcome — a kind, or
 * the router's veto — is kept.
 */
export class FileKindMemo {
  private m: { text: string; kind: TemplateKind | null } | null = null;
  /** The remembered outcome for exactly this text, else undefined (ask again). */
  get(text: string): TemplateKind | null | undefined { return this.m?.text === text ? this.m.kind : undefined; }
  /** A real outcome replaces whatever stood; a non-answer changes nothing. */
  set(text: string, kind: TemplateKind | null | undefined): void { if (kind !== undefined) this.m = { text, kind }; }
}

// ------------------------------------------------------------------ a series of yes/no questions

/**
 * The router does not sort in one go among eighteen kinds, which is a lot to ask of a tiny model. It is asked a series of simple questions,
 * each answered with one word, yes or no: the first thing it says is the whole answer, so each costs little more than the time to the first
 * token. Each answer picks the next question, down to a kind. The request comes first and only the question changes, so the model reads the
 * request once and the questions that follow only add a few words.
 */
export interface Node { ask: string; yes: string; no: string }

/**
 * A next step is another question (an id starting with q_) or a kind (a name of CATEGORY_IDS). The tree is short on purpose: code is found
 * in 2 to 4 questions, a text to write in 3 to 5, a question about the world in 4, a plain conversation in 7, and the most common ones are
 * asked first.
 */
export const TREE: Record<string, Node> = {
  q_code: { ask: "Does it ask for computer code, a program or a script, or about code the person has?", yes: "q_error", no: "q_text" },
  q_error: { ask: "Is the problem an error, a bug, or something that does not work?", yes: "code_repair", no: "q_read" },
  q_read: { ask: "Does it ask to explain, read or review code that already exists?", yes: "code_explain", no: "q_web" },
  q_web: { ask: "Is it something to see or use in a web browser: a page, a game, an animation or an interface?", yes: "web_code", no: "python_code" },
  q_text: { ask: "Does it ask to write, translate, rewrite or summarize a text?", yes: "q_translate", no: "q_think" },
  q_translate: { ask: "Does it ask to translate a text from one language to another?", yes: "translate_other", no: "q_creative" },
  q_creative: { ask: "Does it ask for a story, a poem, a song or other creative writing?", yes: "creative", no: "q_message" },
  q_message: { ask: "Does it ask to write an email, a letter or a message to someone?", yes: "writing", no: "summarize" },
  q_think: { ask: "Does it need a calculation, an equation, a logic puzzle or step-by-step reasoning?", yes: "q_math", no: "q_fact" },
  q_math: { ask: "Is it a calculation, an equation or a maths problem (not a logic puzzle)?", yes: "math", no: "reasoning" },
  q_fact: { ask: "Is it a question about facts, the world, or how something works?", yes: "knowledge", no: "q_plan" },
  q_plan: { ask: "Does it ask for a plan, a schedule, or a list of steps to organize something?", yes: "planning", no: "q_structure" },
  q_structure: { ask: "Does it ask to extract data, to answer as JSON, a table or another strict structure, or to draw a chart or graph of numbers?", yes: "tool_use", no: "q_format" },
  q_format: { ask: "Does it set an exact format, length or other strict constraint on the answer?", yes: "instruction", no: "chat" }
};
export const ROOT = "q_code";

const KINDS = new Set<string>(CATEGORY_IDS);
const isKind = (id: string): id is TaskCategory => KINDS.has(id);

/** The question to ask first for a request the words already lean towards a kind: a yes goes straight down towards it. */
export const CONFIRM: Partial<Record<TaskCategory, string>> = {
  web_code: "q_code", python_code: "q_code", code_repair: "q_code", code_explain: "q_code", translate_other: "q_translate", math: "q_math",
  knowledge: "q_fact", creative: "q_creative", writing: "q_message", summarize: "q_text", planning: "q_plan", tool_use: "q_structure", reasoning: "q_think", instruction: "q_format"
};

const CODE_LEAF: Partial<Record<TaskCategory, string>> = { web_code: "q_web", code_repair: "q_error", code_explain: "q_read" };

/**
 * Every decision about a request is one of these closed questions, put to the router (the chat model when the router does not answer), never read from the words of the message.
 * The prompt lab (`docs/prompt-lab/prompt-lab-router.md`) asks the same questions with hard requests, so a change here is measured there.
 */
export const Q = {
  program: "Does it ask to build, write or change something that RUNS: a program, game, app, tool or web page, or say that something in one does not work or looks wrong? (Answer no for a chat, a question, an explanation, a chart, a spreadsheet, an Excel or Word file, a text document, a story, a poem, an essay or other creative writing, or a thanks.)",
  produce: "Does the person ask you to PRODUCE a file or a document now (make it, write it, create it), rather than ask for help, advice, an explanation, a summary, a review, or just talk?",
  produce2: "Does the message tell you to make, write or create a new file or document for the person (a letter, a sheet, a report, a CV)?",
  produce3: "Is the thing wanted a NEW file or document as the result, rather than an answer in the chat?",
  sheet: "Does it ask for an Excel spreadsheet, a table of figures, or a sheet to fill in or to calculate in?",
  word: "Does it ask for a written document to be made (a letter, a report, a CV, minutes, a contract, a research document)?",
  site: "Does it ask for a website, a landing page or a web page to show to people?",
  calculator: "Does it ask for a small calculator, converter or simulator page with inputs and a result?",
  exercise: "Does it give its own figures and ask for something to be worked out or answered from them (an exercise, a cost, a valuation), rather than an empty sheet or a general template?",
  file: "What file does the request ask to be made? sheet = an Excel spreadsheet or a table of figures; document = a written document (a letter, a report, a CV, minutes, a contract, a research document); site = a website or a landing page; calculator = a small calculator, converter or simulator page; none = anything else (a program, a game, a chat, a question, a chart).",
  web: "Does answering it need recent facts, or looking something up on the web, that a model would not know by heart?",
  identity: "Is the message asking who you are, what your name is, or who made or built you? (Answer no when it asks you to make, write or change anything, or asks about a person, a thing or any other subject.)",
  programConfirm: "Does the message ask you to make a program, page or file? (Answer no when it only asks a question or wants an answer in the chat, such as a story, a poem, an essay or other creative writing.)",
  agents: "Does this request ask for sub-agents, or is it a big job that splits into independent parts that can each be worked out alone (researching several things, drafting several sections, comparing several options)? (Answer no for a greeting, a chat, a small question or a single simple task.)",
  recall: "Does the message ask about something that was said, decided, written or agreed EARLIER in the conversation, which the summary of it at the start may not hold in full (an earlier answer, an earlier file, a value or a name from before)? (Answer no when the message is only about what is on the screen now, or asks for something new.)"
} as const;

/** A heavy decision is asked in three different wordings, never the same one three times (a greedy model answers the same words the same way): two that agree settle it, else the third. */
export const PRODUCE_VOTES = [Q.produce, Q.produce2, Q.produce3] as const;

/** What the answers so far settle: true or false once more than half of `total` agree, undefined while it is open. */
export function settled(answers: readonly boolean[], total: number): boolean | undefined {
  const yes = answers.filter(Boolean).length, no = answers.length - yes;
  return yes > total / 2 ? true : no > total / 2 ? false : undefined;
}

export const FILE_CHOICES = ["sheet", "document", "site", "calculator", "none"] as const;

/** A question with a short list of answers: the router replies with one word of the list. */
export function choicePrompt(text: string, ask: string, options: readonly string[]): { system: string; user: string } {
  return {
    system: "You sort a request that a person sent to an assistant. Reply with one word from the list. Judge by what the request asks for, not by the language it is written in.",
    user: `Request: """${text.trim().slice(0, 600)}"""\nQuestion: ${ask}\nAnswer with one of: ${options.join(", ")}.\nAnswer:`
  };
}

/** The option the reply starts with, or null. */
export function parseChoice<T extends string>(reply: string, options: readonly T[]): T | null {
  const w = reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, " ").toLowerCase().match(/[a-z]+/)?.[0];
  return options.find((o) => o === w) ?? null;
}

/** The web search for a request, written by the router: the topic and what is wanted, not what is to be done with it. */
export function searchQueryPrompt(text: string): { system: string; user: string } {
  return {
    system: "You write web search queries. Reply with the query only.",
    user: `Request: """${text.trim().slice(0, 600)}"""\nWrite the web search query that finds what this request needs: only the topic and the facts wanted, 2 to 8 words, no greeting, nothing about what to make or write with the result. Query:`
  };
}

/** The query as the router wrote it, or null when it is empty, too long or not a line of words. */
export function readSearchQuery(reply: string): string | null {
  const line = reply.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, " ").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const q = line.replace(/^(?:query)\s*:\s*/i, "").replace(/^["'`«“]+|["'`»”.]+$/g, "").trim();
  // a line of words: no code-like token ("no_result"), no answer that says there is none
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '’.,\-+#&/]*$/u.test(q) || /^(?:none|n\/a|no result|no query)$/i.test(q)) return null;
  return q.length >= 3 && q.length <= 100 && q.split(/\s+/).length <= 14 ? q : null;
}

/**
 * A few solved cases for each question, in its own system message (a small model that answers every closed question alone said "no" to most of the requests that should get a "yes": a converter, a spreadsheet to make,
 * a game described at length; with greedy decoding that is 72 % right on the lab's 144 hard requests). They are about other subjects than the lab's requests, so the lab still measures.
 */
const SHOTS: [string, [string, boolean][]][] = [
  [Q.program, [["make me a tic-tac-toe game", true], ["I would like a stopwatch app with lap times", true], ["the score does not update after a level, fix it", true], ["add a dark mode switch to the page", true],
    ["make me a chess game I can play against the computer", true], ["أريد لعبة إكس-أو ألعبها ضد الكمبيوتر", true],
    ["explain the difference between a list and a tuple in python", false], ["write an email to move my appointment", false], ["make me an excel table of my groceries", false], ["what is the capital of Canada?", false],
    ["what was the score of yesterday's game?", false], ["write me a 500-word story about a dragon who opens a bakery", false], ["a poem about autumn in Kyoto, four verses", false]]],
  [Q.produce, [["create a rental contract for me as a Word document", true], ["make an Excel file with my monthly expenses", true], ["do some research on solar panels and write a report", true], ["make me a family budget in a spreadsheet", true],
    ["can you check my CV and tell me what to improve?", false], ["I have a probability exercise, can you help me understand it?", false], ["here, this is my file", false], ["can you summarize this text for me?", false]]],
  [Q.sheet, [["a workbook to track my employees' hours", true], ["build me a spreadsheet to compare three loan offers", true], ["a monthly budget in excel", true],
    ["write a speech for my sister's wedding", false], ["what is the difference between SUM and SUMIF?", false], ["make a site for my association", false]]],
  [Q.word, [["write a resignation letter", true], ["make a project proposal for a mobile app", true], ["do some research on electric cars and make a research doc", true],
    ["translate this sentence into Arabic", false], ["my printer does not work, any idea?", false], ["make a spreadsheet of my expenses", false]]],
  [Q.site, [["a one-page site for my yoga classes", true], ["make a site to present my association", true], ["a portfolio page for a photographer", true],
    ["explain what DNS is", false], ["write the text of an about-us paragraph", false], ["make a pong game", false]]],
  [Q.calculator, [["a tip calculator", true], ["a page that converts miles to kilometers", true], ["a car loan simulator", true],
    ["what is 45 times 12?", false], ["make me a todo app", false], ["make a repayment spreadsheet", false]]],
  [Q.exercise, [["I buy 12 items at 7.50 € with a 20 % discount, work out the total in a spreadsheet", true], ["Salary 3200, rent 900, food 400: work out what is left, in a sheet", true],
    ["make me a blank invoice", false], ["explain how to work out a weighted average", false], ["a template to track my hours", false]]],
  [Q.web, [["what's the weather in Paris this weekend?", true], ["latest news on the stock market", true], ["what is the price of gold today?", true],
    ["write a haiku about rain", false], ["explain photosynthesis", false], ["translate hello into Arabic", false]]],
  [Q.identity, [["what should I call you?", true], ["tell me about yourself — who created this app of yours?", true], ["هل أنت ذكاء اصطناعي؟ من صمّمك؟", true], ["بصراحة، مَن اسمك؟", true],
    ["make me a chatbot page for my shop", false], ["write a poem about a robot who lost its name", false], ["من هو مخترع الهاتف؟", false], ["make me a site for my robotics club", false]]],
  // the confirming question of the build gate (a yes from the chat model alone, the router not saying yes): other subjects than the lab's requests and the eval cases
  [Q.programConfirm, [["build me a pomodoro timer page", true], ["make a small program that renames my photos by the date taken", true], ["زر الحفظ في الأداة لا يعمل، أصلحه", true],
    ["what time does the museum open?", false], ["ما عاصمة اليابان؟", false], ["summarize the meeting notes for me", false], ["tell me a long story about a fox who sails to Greece", false], ["write a poem for my mother's birthday", false]]]
];
const SHOTS_OF = new Map<string, [string, boolean][]>([...SHOTS, [Q.produce2, SHOTS[1][1]], [Q.produce3, SHOTS[1][1]]]);
/** The solved cases of the question (a context line may stand in front of it), written on one line. */
const shotsFor = (ask: string): string => {
  for (const [q, shots] of SHOTS_OF) if (ask.endsWith(q)) return shots.map(([r, y]) => `${r} -> ${y ? "yes" : "no"}`).join("; ");
  return "";
};

/** What one question asks the router: the request is the same each time, so it is read once. */
export function yesNoPrompt(text: string, ask: string): { system: string; user: string } {
  const shots = shotsFor(ask);
  return {
    system: `You answer yes/no questions about a request that a person sent to an assistant. Reply with one word: yes or no. Judge by what the request asks for, not by the language it is written in.${shots ? ` Solved cases for this question: ${shots}.` : ""}`,
    user: `Request: """${text.trim().slice(0, 600)}"""\nQuestion: ${ask}\nAnswer (yes or no):`
  };
}

/** yes, no, or null when the reply is neither. */
export function parseYesNo(reply: string): boolean | null {
  const w = reply.replace(/<think>[\s\S]*?<\/think>/g, " ").toLowerCase().match(/[a-z]+/)?.[0];
  return w === "yes" || w === "y" ? true : w === "no" || w === "n" ? false : null;
}

export interface Asked { id: string; yes: boolean }

/**
 * Sorts a request by asking `answer` the questions of the tree, each at most once. `lean` is the kind the words lean towards: its question
 * comes first, and a yes goes straight down towards it. A reply that is neither yes nor no, or too many questions, gives null (the words'
 * guess then stands).
 */
export async function sortByQuestions(answer: (ask: string, id: string) => Promise<boolean | null>, lean?: TaskCategory, maxQuestions = 8): Promise<{ kind: TaskCategory | null; asked: Asked[] }> {
  const asked: Asked[] = [];
  const known = new Map<string, boolean>();
  const ask = async (id: string): Promise<boolean | null> => {
    if (known.has(id)) return known.get(id)!;
    const r = await answer(TREE[id].ask, id);
    if (r !== null) { asked.push({ id, yes: r }); known.set(id, r); }
    return r;
  };
  const walk = async (start: string): Promise<TaskCategory | null> => {
    let id = start;
    for (;;) {
      if (isKind(id)) return id;
      if (!TREE[id] || asked.length >= maxQuestions) return null;
      const r = await ask(id);
      if (r === null) return null;
      id = r ? TREE[id].yes : TREE[id].no;
    }
  };
  const first = lean ? CONFIRM[lean] : undefined;
  if (first) {
    const r = await ask(first);
    if (r === null) return { kind: null, asked };
    // in the code questions, the one that names the kind the words lean towards comes next: a second yes ends it
    const leaf = r && first === ROOT && lean ? CODE_LEAF[lean] : undefined;
    if (leaf) {
      const r2 = await ask(leaf);
      if (r2 === null) return { kind: null, asked };
      if (r2) return { kind: await walk(TREE[leaf].yes), asked };
    }
    return { kind: await walk(r ? (leaf ? "q_error" : TREE[first].yes) : first === ROOT ? TREE[first].no : ROOT), asked };
  }
  return { kind: await walk(ROOT), asked };
}

/** Does this sort need the router? Not when it is sure, nor when the request is an image or a very long text (the shape says it). */
export const routerWanted = (s: Sorted): boolean => s.confidence < ROUTER_BELOW && s.category !== "vision" && s.category !== "long_context";

/** The rules' sort with the router's word put in. */
export const withRouter = (s: Sorted, kind: TaskCategory | null): Sorted => (kind ? { category: kind, confidence: 0.82, reason: "the router model sorted it" } : s);

/** Small memory of what was sorted: asking again (a retry, the same words) costs nothing. */
export class SortMemory {
  private m = new Map<string, TaskCategory>();
  constructor(private max = 60) {}
  clear() { this.m.clear(); }
  get(text: string) { return this.m.get(text.trim().toLowerCase()); }
  set(text: string, kind: TaskCategory) {
    const k = text.trim().toLowerCase();
    this.m.delete(k);
    this.m.set(k, kind);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
}
