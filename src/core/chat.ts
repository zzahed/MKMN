import { ChatEvent, ChatMessage, ChatStats, ContentPart, Sampling } from "../shared/types";
import { CONTINUE_PROMPT, endsOpen, fitMessages, isContextOverflow, joinContinuation, replyReserve, windowAnswer } from "./context";
import { findLoop } from "./loops";
import { loopRetrySampling, requestSampling } from "./sampling";

/**
 * Splits a streamed completion into hidden thinking and the visible answer.
 * Handles tags broken across chunks and templates that open the thought in the prompt
 * (output starts inside the thought and only a closing </think> appears).
 */
export class ThinkSplitter {
  private buf = "";
  private inThink: boolean;
  private seenAny = false;
  /** A closing </think> was met. */
  closed = false;
  constructor(assumeOpen = false) {
    this.inThink = assumeOpen;
  }

  push(chunk: string): { thinking: string; answer: string } {
    this.buf += chunk;
    let thinking = "";
    let answer = "";
    for (;;) {
      if (!this.inThink && !this.seenAny) {
        // only treat an opening tag as a tag at the very start
        const t = this.buf.trimStart();
        if ("<think>".startsWith(t) && t.length < "<think>".length) break; // might become a tag
      }
      const tag = this.inThink ? "</think>" : "<think>";
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        const before = this.buf.slice(0, i);
        if (this.inThink) thinking += before;
        else answer += before;
        this.buf = this.buf.slice(i + tag.length);
        if (this.inThink) this.closed = true;
        this.inThink = !this.inThink;
        this.seenAny = true;
        continue;
      }
      // keep a possible partial tag at the end
      let keep = 0;
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) { keep = k; break; }
      }
      const out = this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      if (this.inThink) thinking += out;
      else answer += out;
      if (out) this.seenAny = true;
      break;
    }
    return { thinking, answer };
  }

  /** The server sends the thinking in its own field: what is in `content` is the answer. */
  leaveThink() {
    this.inThink = false;
    this.seenAny = true;
  }

  flush(): { thinking: string; answer: string } {
    const rest = this.buf;
    this.buf = "";
    return this.inThink ? { thinking: rest, answer: "" } : { thinking: "", answer: rest };
  }
}

/** One streamed chunk as a server may send it: every field is checked before it is used. */
type SseDelta = { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
type SseChunk = {
  choices?: { delta?: SseDelta; finish_reason?: string | null }[];
  usage?: { completion_tokens?: unknown; prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  timings?: { prompt_n?: unknown };
};

/** Parse one SSE `data:` payload; returns null for [DONE] / keep-alives. */
export function parseSseData(data: string): { content?: string; reasoning?: string; usageTokens?: number; promptTokens?: number; cachedTokens?: number; promptEvaluated?: number; finish?: string } | null {
  const d = data.trim();
  if (!d || d === "[DONE]") return null;
  let j: SseChunk;
  try { j = JSON.parse(d); } catch { return null; }
  const delta: SseDelta = j.choices?.[0]?.delta ?? {};
  return {
    content: typeof delta.content === "string" ? delta.content : undefined,
    reasoning: typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : undefined,
    usageTokens: typeof j.usage?.completion_tokens === "number" ? j.usage.completion_tokens : undefined,
    promptTokens: typeof j.usage?.prompt_tokens === "number" ? j.usage.prompt_tokens : undefined,
    cachedTokens: typeof j.usage?.prompt_tokens_details?.cached_tokens === "number" ? j.usage.prompt_tokens_details.cached_tokens : undefined,
    promptEvaluated: typeof j.timings?.prompt_n === "number" ? j.timings.prompt_n : undefined,
    finish: j.choices?.[0]?.finish_reason ?? undefined
  };
}

/**
 * The prompt tokens the server really evaluated: what a prefill rate is measured on. GenieX 0.11.0 counts the
 * reused KV-cache prefix in `prompt_tokens`, so a prompt that shares its start with the last one would read as
 * a prefill many times faster than the hardware. `timings.prompt_n` first, else the total less the cached part,
 * else the total (a server that reports no reuse evaluated all of it).
 */
export function evaluatedPromptTokens(s: { promptTokens?: number; promptEvaluated?: number; cachedTokens?: number }): number | undefined {
  if (typeof s.promptEvaluated === "number") return s.promptEvaluated;
  if (typeof s.promptTokens !== "number") return undefined;
  return typeof s.cachedTokens === "number" ? Math.max(0, s.promptTokens - s.cachedTokens) : s.promptTokens;
}

export interface StreamOptions {
  endpoint: string; // http://127.0.0.1:18181/v1
  model: string;
  messages: ChatMessage[];
  sampling: Sampling;
  signal?: AbortSignal;
  now?: () => number;
  fetchFn?: typeof fetch;
  /** Extra request fields (thinking switch). Sampling fields win on conflict. */
  body?: Record<string, unknown>;
  /** The chat template opens <think> itself (Thinking / Reasoning releases), so the output starts inside the thought. */
  thinkOpen?: boolean;
  /** Fields this server refused earlier: not sent again. Filled in when a server refuses one, so the caller keeps it for the next request. */
  refused?: Set<string>;
  /** Called when the server refused optional fields and the request was sent again without them. */
  onDropped?: (fields: string[], serverSaid: string) => void;
  /**
   * Seconds the server may send nothing at all (in the request itself or in the stream) before the
   * client health-checks it instead of waiting forever. 0 turns the watch off; the default is 90.
   */
  noProgressSec?: number;
  /**
   * Puts the model server back up through the supervisor that owns it (stop, start, wait until it
   * serves). Used at most once per call, when the server stopped serving mid-call; the request is
   * then asked once more. Absent, a stalled call just fails.
   */
  recover?: () => Promise<boolean>;
}

/** Thrown when the server sent nothing for too long and its health check did not vouch for it: the call ends instead of waiting forever. */
export class ServerLostError extends Error {
  constructor(message: string) { super(message); this.name = "ServerLostError"; }
}

/** Internal: the no-progress window ran out; the stall watch handles it and it never escapes. */
class Stall extends Error {}

/** Seconds a stream may send nothing at all before the client health-checks the server instead of waiting forever.
 * One value for the whole app (the gateway passes it on every call, and its re-export is the public face):
 * the acceptance measurements had a server answering posts in 5-17 s and then staying silent far past this
 * window, and the probe and recovery take seconds more — 45 s is twice the normal silence and half the old
 * worst-case wait. The window resets on every byte the server sends, so only true silence ever runs it out. */
export const NO_PROGRESS_SEC = 45;

/**
 * Silent windows a local GenieX may take while its own `/status` shows the model "loading" or "active" (8 x 45 s = 6 min).
 * A model released by `--keepalive` is loaded again by the next request with no byte sent until the load ends, and an
 * 8B NPU model took 56-97 s here: read only by `/v1/models` (which lists the whole cache, loaded or not), that load was a
 * server "up, not serving", given up and restarted mid-load. Past this many windows the call ends as before.
 */
export const BUSY_WINDOWS_MAX = 8;

const isLoopback = (endpoint: string) => {
  try { return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(new URL(endpoint).hostname); } catch { return false; }
};

/**
 * Optional request fields: leaving one out changes how the answer is written, not what
 * is asked. The thinking fields are here too — the verified GenieX contract accepts
 * `enable_think` / `reasoning_effort` / `chat_template_kwargs`, but servers differ and
 * a 400 that names one of them must degrade to a request without it, never kill the
 * conversation.
 */
const MAX_LOOP_RETRIES = 3;

const OPTIONAL_FIELDS = ["stream_options", "response_format", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "top_p", "seed", "enable_think", "chat_template_kwargs", "reasoning_effort"];

/** The optional fields a 400 answer complains about; with no field named, the penalties and `top_k`, which are the usual ones. */
export function droppableFields(errorText: string, body: Record<string, unknown>): string[] {
  if (!/unsupported|unknown|not supported|unrecognized|invalid/i.test(errorText)) return [];
  const present = OPTIONAL_FIELDS.filter((k) => k in body);
  const named = present.filter((k) => errorText.includes(k) || (/penalt/i.test(errorText) && /penalty/.test(k)));
  if (named.length) return named;
  // GenieX (0.10.0, #1611) answers 400 with its own SDK code for a request it could not EXECUTE (a picture or a
  // sound it cannot load: -201001...); no field caused it, so none is dropped (dropping them all, remembered as
  // refused, took the thinking switch and the penalties from the rest of the chat, and the retry failed anyway)
  if (/"code"\s*:\s*-\d{5,}/.test(errorText)) return [];
  return present.filter((k) => k !== "top_p" && k !== "stream_options");
}

/**
 * The roles the OpenAI-compatible endpoint accepts. Anything else (a `tool` or
 * `function` message restored from an old conversation, say) makes GenieX fail the
 * whole request with its generic SDK error, code -100000, in milliseconds.
 */
const SERVER_ROLES = new Set(["system", "user", "assistant"]);

/** Join two messages' content (measured on Gemma: adjacent same-role turns and a system message in the middle both fail with code -100000; the merged forms answer 200). */
function joinContent(a: string | ContentPart[], b: string | ContentPart[]): string | ContentPart[] {
  if (typeof a === "string" && typeof b === "string") {
    return !a.trim() ? b : !b.trim() ? a : `${a}\n\n${b}`;
  }
  const toParts = (x: string | ContentPart[]): ContentPart[] =>
    typeof x === "string" ? [{ type: "text", text: x }] : x;
  return [...toParts(a), ...toParts(b)];
}

function mergeAdjacent(messages: ChatMessage[]): ChatMessage[] {
  const kept: ChatMessage[] = [];
  for (const m of messages) {
    const prev = kept[kept.length - 1];
    if (prev && prev.role === m.role) prev.content = joinContent(prev.content, m.content);
    else kept.push({ role: m.role, content: m.content });
  }
  return kept;
}

/**
 * Coerce the outgoing conversation to what the server accepts, measured on the
 * GenieX Gemma template:
 * - roles it does not know are dropped (a `tool` turn fails the whole request);
 * - consecutive same-role turns are merged (user, user → one user turn);
 * - system instructions are consolidated at the front (a system turn in the
 *   middle fails; the same text as a leading system turn answers).
 * Content is never discarded and roles keep their authority; at least one message
 * always remains.
 */
export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const valid: ChatMessage[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object" || !SERVER_ROLES.has(String(m.role))) continue;
    const content = typeof m.content === "string"
      ? (m.content.length ? m.content : " ")
      : Array.isArray(m.content) && m.content.length ? m.content : " ";
    valid.push({ role: m.role, content });
  }
  let kept = mergeAdjacent(valid);
  const systems = kept.filter((m) => m.role === "system");
  if (systems.length && (kept[0]?.role !== "system" || systems.length > 1)) {
    const merged: ChatMessage = {
      role: "system",
      content: systems.reduce((acc: string | ContentPart[], m) => joinContent(acc, m.content), " ")
    };
    // Removing the middle system turns its neighbors into new adjacency
    // (user, system, user → user, user): the merge pass runs AGAIN after the
    // reorder, or the request leaves with the exact adjacency this function
    // exists to eliminate.
    kept = mergeAdjacent([merged, ...kept.filter((m) => m.role !== "system")]);
  }
  return kept.length ? kept : [{ role: "user", content: " " }];
}

/**
 * Stream a chat completion, yielding thinking / answer deltas and a final stats event.
 * tok/s is computed on generation time (after the first token); tokens come from usage when
 * the server sends it, otherwise the number of content chunks — flagged `tokensEstimated`,
 * because chunks are not tokens (one chunk can hold a whole sentence).
 *
 * The fail-fast rule wraps every attempt: when the request or the stream sends nothing for
 * `noProgressSec`, the server's `/v1/models` is asked. Gone — or up yet still silent after one
 * more window — the call ends, naming the call, instead of hanging forever; with `recover`,
 * the server is brought back once and the request is asked once more (a partial answer of the
 * dead attempt is taken back first, so nothing is ever written twice).
 */
export async function* streamChat(opts: StreamOptions, id: string): AsyncGenerator<ChatEvent> {
  for (let n = 0; ; n++) {
    let wrote = false;
    try {
      for await (const ev of streamAttempt(opts, id)) {
        if (ev.type === "thinking" || ev.type === "answer") wrote = true;
        yield ev;
      }
      return;
    } catch (e) {
      if (!(e instanceof ServerLostError) || opts.signal?.aborted || n > 0 || !opts.recover) throw e;
      yield { id, type: "notice", text: "The model server stopped serving mid-call. Restarting it before retrying." };
      let back: boolean;
      try { back = (await opts.recover()) === true; } catch { back = false; }
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (!back) throw new ServerLostError(`${e.message}; the model server could not be brought back, so the call was not retried`);
      // the dead attempt's words are taken back, so the retry starts the answer from a clean slate
      if (wrote) yield { id, type: "retract", keep: 0 };
    }
  }
}

/**
 * What a cloud endpoint needs on every request to it: its key header, and the provider's own defaults as
 * body fields (a field the request already carries wins). Kept here so no caller handles the key, and
 * never sent to any other endpoint.
 */
type EndpointAuth = { headers?: Record<string, string>; body?: Record<string, unknown> };
const endpointAuth = new Map<string, EndpointAuth>();
const endpointKey = (endpoint: string) => endpoint.replace(/\/+$/, "");
export function registerEndpointAuth(endpoint: string, auth: EndpointAuth | null): void {
  if (auth) endpointAuth.set(endpointKey(endpoint), auth); else endpointAuth.delete(endpointKey(endpoint));
}
/** What a provider's support asks for when a request fails: its request id, and when to try again (HUMAIN Fuse and Node docs). */
function serverIds(res: Response): string {
  const safe = (v: string | null) => (v && /^[\w.:-]{1,100}$/.test(v) ? v : null);
  const id = safe(res.headers.get("x-request-id")) ?? safe(res.headers.get("x-fuse-request-id"));
  const retry = res.headers.get("retry-after");
  return [id && ` · request ${id}`, retry && /^\d{1,9}$/.test(retry) && ` · retry after ${retry}s`].filter(Boolean).join("");
}
const authOf = (endpoint: string) => endpointAuth.get(endpointKey(endpoint));
const headersFor = (endpoint: string): Record<string, string> => ({ "Content-Type": "application/json", ...authOf(endpoint)?.headers });

/** One request, streamed, with the no-progress watch; the fail-fast retry around it is `streamChat`. */
async function* streamAttempt(opts: StreamOptions, id: string): AsyncGenerator<ChatEvent> {
  const now = opts.now ?? (() => performance.now());
  const f = opts.fetchFn ?? fetch;
  const t0 = now();
  // The no-progress watch: a server that hangs (alive, not serving — the acceptance
  // saw the model server sit in state "ready" while a call sat on a dead stream for good)
  // must end the CALL in seconds, never hold the whole build. Every wait is raced against
  // a window; when a window runs out, /v1/models decides: gone, or up and silent a second
  // window, the call fails.
  const noProgressMs = opts.noProgressSec === 0 ? 0 : Math.round((opts.noProgressSec ?? NO_PROGRESS_SEC) * 1000);
  let silentWindows = 0;
  let busyWindows = 0;
  /** What a local GenieX says it is doing (`GET /status`, v0.10.0 and later): a model it is loading or answering, else null. */
  const atWork = async (): Promise<string | null> => {
    if (!isLoopback(opts.endpoint)) return null; // a cloud endpoint is never asked for anything but the call itself
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await f(`${opts.endpoint.replace(/\/+$/, "").replace(/\/v1$/, "")}/status`, { method: "GET", signal: ac.signal });
      if (!r.ok) { await r.arrayBuffer().catch(() => undefined); return null; }
      const j = await r.json().catch(() => null) as { models?: { id?: unknown; state?: unknown }[] } | null;
      const busy = Array.isArray(j?.models) ? j!.models.find((m) => m?.state === "loading" || m?.state === "active") : undefined;
      return busy ? `its /status shows ${String(busy.id ?? "a model")} ${String(busy.state)}` : null;
    } catch { return null; } finally { clearTimeout(timer); }
  };
  const probe = async (): Promise<string> => {
    const work = await atWork();
    if (work && busyWindows < BUSY_WINDOWS_MAX) { busyWindows++; return `busy: ${work}`; }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000); // the health check itself must never be the wait that hangs
    try {
      if (work) return `${work} after ${busyWindows} windows (it never moved on to this call)`;
      const r = await f(`${opts.endpoint}/models`, { method: "GET", headers: headersFor(opts.endpoint), signal: ac.signal });
      await r.arrayBuffer().catch(() => undefined);
      return r.ok ? "it answers /v1/models but sent nothing more (it is up, not serving)" : `the health check /v1/models answered HTTP ${r.status}`;
    } catch (e) {
      return `the health check /v1/models failed (${(e as Error).message})`;
    } finally { clearTimeout(timer); }
  };
  const lost = (windows: number, detail: string) => {
    const ms = windows * noProgressMs;
    const quiet = ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
    return new ServerLostError(`the model call ${id} failed: the server sent nothing for ${quiet} and ${detail}`);
  };
  const guarded = async <T>(p: Promise<T>): Promise<T> => {
    if (!noProgressMs) return p;
    void p.catch(() => undefined); // a late rejection while the health check runs must not become an unhandled one
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Stall()), noProgressMs); })]);
      } catch (e) {
        if (!(e instanceof Stall) || opts.signal?.aborted) throw e;
        const detail = await probe();
        if (detail.startsWith("busy: ")) continue; // the server is loading or answering: that is progress, the windows are not counted
        silentWindows++;
        if (silentWindows >= 2 || !detail.includes("up, not serving")) throw lost(silentWindows + busyWindows, detail);
        // the server still answers /v1/models: one more window before the call is given up
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
  };
  // A server that does not know an optional field answers 400 and names it (Foundry Local refuses a non-zero penalty): the fields that are
  // only a preference are dropped, and the request is sent again, rather than the whole test failing for a setting.
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: sanitizeMessages(opts.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...authOf(opts.endpoint)?.body,
    ...opts.body,
    ...requestSampling(opts.sampling)
  };
  for (const k of opts.refused ?? []) delete body[k];
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await guarded(f(`${opts.endpoint}/chat/completions`, {
      method: "POST",
      headers: headersFor(opts.endpoint),
      signal: opts.signal,
      body: JSON.stringify(body)
    }));
    silentWindows = 0; // the server took the request: progress again
    if (res.ok && res.body) break;
    const text = await res.text().catch(() => "");
    const dropped = res.status === 400 && attempt < 3 ? droppableFields(text, body) : [];
    // The summary rides along on every thrown server error: a generic failure
    // (GenieX's SDK error -100000, say) is only diagnosable from what was asked.
    if (!dropped.length) throw new Error(`Server error ${res.status}${serverIds(res)}: ${text.slice(0, 400)} (${requestSummary(body)})`);
    for (const k of dropped) { delete body[k]; opts.refused?.add(k); }
    opts.onDropped?.(dropped, text.slice(0, 240));
  }

  const splitter = new ThinkSplitter(!!opts.thinkOpen);
  let thought = "";
  let viaField = false;
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let sse = "";
  let tFirst: number | null = null;
  let tAnswer: number | null = null;
  let chunks = 0;
  let usageTokens: number | undefined;
  let promptTokens: number | undefined;
  let promptEvaluated: number | undefined;
  let cachedTokens: number | undefined;
  let finish: string | null = null;
  let receivedDone = false;
  // set when the connection died mid-answer: the words already streamed stand, the turn ends done and marked, it is not thrown away
  let cut: string | null = null;

  const emit = function* (t: string, a: string): Generator<ChatEvent> {
    if (t) { thought += t; yield { id, type: "thinking", text: t }; }
    if (a) { if (tAnswer === null && a.trim()) tAnswer = now(); yield { id, type: "answer", text: a }; }
  };

  try {
  for (;;) {
    const { value, done } = await guarded(reader.read());
    if (done) break;
    silentWindows = 0; // bytes arrived: the server is serving
    sse += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = sse.indexOf("\n")) >= 0) {
      const line = sse.slice(0, nl).replace(/\r$/, "");
      sse = sse.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { receivedDone = true; continue; }
      const p = parseSseData(data);
      if (!p) continue;
      if (p.usageTokens !== undefined) usageTokens = p.usageTokens;
      if (p.promptTokens !== undefined) promptTokens = p.promptTokens;
      if (p.promptEvaluated !== undefined) promptEvaluated = p.promptEvaluated;
      if (p.cachedTokens !== undefined) cachedTokens = p.cachedTokens;
      if (p.finish) finish = p.finish;
      if (p.reasoning) {
        if (!viaField) { viaField = true; splitter.leaveThink(); }
        if (tFirst === null) tFirst = now();
        chunks++;
        yield { id, type: "thinking", text: p.reasoning };
      }
      if (p.content) {
        if (tFirst === null) tFirst = now();
        chunks++;
        const s = splitter.push(p.content);
        yield* emit(s.thinking, s.answer);
      }
    }
  }
  } catch (e) {
    if (opts.signal?.aborted || (e as Error).name === "AbortError") throw e; // the person (or the caller) stopped the turn: nothing to end gracefully
    // A stall already went through the health check: it must reach the fail-fast retry, not the
    // no-streaming fallback (asking a server that stopped serving again, streaming or not, waits all the same).
    if (e instanceof ServerLostError) throw e;
    if (chunks === 0) {
    // The connection was cut before the first word ("terminated"): some servers cannot stream. The same request is sent once without streaming,
    // which either answers or says why in plain words.
    yield* completeOnce(opts, f, body, id, now, t0, `${(e as Error).message} after ${Math.round(now() - t0)} ms, no word received; ${requestSummary(body)}`);
    return;
    }
    // The server stopped MID-ANSWER ("terminated"): the words already streamed are real output
    // the person watched arrive — the stream ends with them, honestly marked, instead of throwing
    // the turn away (an on-device test run: "Something went wrong, restart MKMN" for a
    // connection cut, the partial answer left standing unmarked). A finish reason that already
    // arrived means the answer itself was complete; the cut after it is harmless.
    if (finish === null && !receivedDone) cut = String((e as Error).message || "the connection was cut");
  }
  if (!cut && finish === null && !receivedDone) cut = "the stream ended before a completion signal";
  if (cut && chunks === 0) throw new Error(`The model server ended the stream before answering (${cut}).`);
  const rest = splitter.flush();
  yield* emit(rest.thinking, rest.answer);
  // assumed an open thought, but it never closed and nothing came apart: it was the answer all along
  if (opts.thinkOpen && !viaField && !splitter.closed && thought.trim()) yield { id, type: "answer", text: thought };
  if (cut) yield { id, type: "notice", text: `The model server stopped mid-answer (${cut}). The answer above is what arrived; send "continue" for the rest.` };

  const tEnd = now();
  const tokens = usageTokens ?? chunks;
  const genSec = tFirst !== null ? (tEnd - tFirst) / 1000 : 0;
  // B13: when the server sent no usage, `tokens` is the number of stream CHUNKS (a chunk
  // can hold a whole sentence): the count and the speed derived from it are estimates and
  // are flagged as such, so they can never pass for verified token throughput.
  const stats: ChatStats = {
    finish: cut ? "cut" : finish,
    ttftSec: tFirst !== null ? Math.round(((tFirst - t0) / 1000) * 100) / 100 : null,
    answerSec: tAnswer !== null ? Math.round(((tAnswer - t0) / 1000) * 100) / 100 : null,
    tokPerSec: genSec > 0.05 && tokens > 1 ? Math.round(((tokens - 1) / genSec) * 10) / 10 : null,
    tokens,
    tokensEstimated: usageTokens === undefined,
    totalSec: Math.round(((tEnd - t0) / 1000) * 100) / 100,
    ...(promptTokens ? { promptTokens } : {}),
    ...(promptEvaluated !== undefined ? { promptEvaluated } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {})
  };
  yield { id, type: "done", stats };
}

/** What was asked, in one line, for an error: the model, how long the prompt was, which fields were sent. Never the text itself. */
export function requestSummary(body: Record<string, unknown>): string {
  const msgs = (body.messages as { content?: unknown }[] | undefined) ?? [];
  const chars = msgs.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length), 0);
  return `request: model ${String(body.model)}, ${msgs.length} messages, ${chars} characters (about ${Math.round(chars / 3.5)} tokens), fields ${Object.keys(body).filter((k) => k !== "messages").join("/")}, max_tokens ${String(body.max_tokens ?? "none")}`;
}

/** The answer of a request made without streaming, given as the same events a stream gives. */
async function* completeOnce(opts: StreamOptions, f: typeof fetch, body: Record<string, unknown>, id: string, now: () => number, t0: number, streamError: string): AsyncGenerator<ChatEvent> {
  const plain: Record<string, unknown> = { ...body, stream: false };
  delete plain.stream_options;
  const res = await f(`${opts.endpoint}/chat/completions`, { method: "POST", headers: headersFor(opts.endpoint), signal: opts.signal, body: JSON.stringify(plain) }).catch((e) => { throw new Error(`${streamError}; asked again without streaming: ${(e as Error).message}`); });
  const text = await res.text().catch((e) => { throw new Error(`${streamError}; asked again without streaming: ${(e as Error).message}`); });
  if (!res.ok) throw new Error(`Server error ${res.status} (the stream was cut: ${streamError}): ${text.slice(0, 400)}`);
  let j: { choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[]; usage?: { completion_tokens?: number } };
  try { j = JSON.parse(text); } catch { throw new Error(`${streamError}; the server's answer without streaming was not readable: ${text.slice(0, 200)}`); }
  const m = j.choices?.[0]?.message;
  if (m?.reasoning_content) yield { id, type: "thinking", text: m.reasoning_content };
  if (m?.content) yield { id, type: "answer", text: m.content };
  const total = Math.round(((now() - t0) / 1000) * 100) / 100;
  const tokens = j.usage?.completion_tokens ?? 0;
  // no first word is seen without streaming: the time to the first token is not known, and the speed is the whole answer over the whole time
  yield { id, type: "done", stats: { finish: j.choices?.[0]?.finish_reason ?? null, ttftSec: null, tokPerSec: total > 0.05 && tokens > 1 ? Math.round((tokens / total) * 10) / 10 : null, tokens, tokensEstimated: j.usage?.completion_tokens === undefined, totalSec: total } };
}

export interface CompleteOptions extends StreamOptions {
  /** The context window of the running server, in tokens. */
  nctx: number;
  /** How many times a cut-off answer is continued (more, while a file keeps growing). */
  maxContinues?: number;
  /** Characters of thought allowed before the first word of the answer; past it the request is cut and ends with finish "think-limit". */
  thinkLimit?: number;
  /**
   * Called once when an answer was cut because the WINDOW was full (not the answer limit): folds the older messages into a summary and
   * returns the shorter request the rest of the answer is continued with, or null when there is nothing to fold.
   */
  compact?: (messages: ChatMessage[]) => Promise<ChatMessage[] | null>;
}

/**
 * streamChat that does not run out of context in the middle of an answer. The request is fitted to the window first
 * (old file versions out, files moved to the end, oldest turns left out), the answer limit is cut to what is left, and an
 * answer that is still cut off (finish "length") is continued from where it stopped, up to a few times, as one stream.
 */
export async function* streamComplete(opts: CompleteOptions, id: string): AsyncGenerator<ChatEvent> {
  const maxContinues = opts.maxContinues ?? 3;
  const refused = opts.refused ?? new Set<string>();
  let loops = 0;
  let continues = 0;
  let all = "";
  let total: ChatStats | null = null;
  let finish: string | null = null;
  // a server that still refuses the request as too long (the estimate was low): it is fitted to a smaller share of the window and sent again
  let squeeze = 1;
  let base = opts.messages;
  let compacted = false;
  let stalls = 0;
  let windowBound = false;
  for (let n = 0; ; n++) {
    if (opts.signal?.aborted) return;
    const reserve = replyReserve(opts.nctx, opts.sampling.max_tokens);
    // the answer so far goes back as a window on its end, so a long file never fills the window by itself
    const messages = !all.trim() ? base : [...base, { role: "assistant" as const, content: windowAnswer(all, Math.max(300, Math.min(1500, Math.floor((opts.nctx - reserve) * 0.3)))) }, { role: "user" as const, content: CONTINUE_PROMPT }];
    const fit = fitMessages(messages, Math.floor((opts.nctx - reserve) * squeeze));
    if (fit.notes.length && n === 0) yield { id, type: "notice", text: fit.notes.join(" ") };
    // fitting that ends in overflow means even the required content (question, system, wrappers) cannot fit:
    // sending it is known-bad, so the turn stops here with what to do instead — and it must stop TERMINALLY:
    // a turn that just stops on a notice leaves the chat busy forever (nothing clears it)
    if (fit.overflow) {
      const budget = Math.floor((opts.nctx - reserve) * squeeze);
      yield { id, type: "notice", text: `This request cannot fit the model's window: about ${fit.tokens.toLocaleString()} tokens against a budget of ${budget.toLocaleString()}, even after the attached files were cut. ${n > 0 ? "The answer stops here; it is kept as written so far. " : ""}Use a model with a bigger window, start a new chat, or ask about a part of the documents.` };
      if (n > 0) {
        // the answer so far was already streamed: it is kept, and the turn ends cleanly with exactly one done
        yield { id, type: "done", stats: { ...(total ?? { ttftSec: null, tokPerSec: null, tokens: 0, totalSec: 0 }), finish: "window-full" } };
      } else {
        // nothing was ever sent: an actionable error, never a successful empty answer
        yield { id, type: "error", error: { id: "context-overflow", title: "This request is too long for the model's window", fix: `The question and everything attached to it need about ${fit.tokens.toLocaleString()} tokens, but only about ${budget.toLocaleString()} fit. Use a model with a bigger window, start a new chat, or ask about a part of the documents.`, raw: `the fitted request was about ${fit.tokens} tokens against a budget of ${budget}` } };
      }
      return;
    }
    else if (n === 0 && fit.tokens > opts.nctx * 0.4) yield { id, type: "notice", text: `Reading about ${fit.tokens.toLocaleString()} tokens before the first word (window ${opts.nctx.toLocaleString()}): the model re-reads the conversation and the code at every message. Its thoughts are never sent back.` };
    const room = opts.nctx - fit.tokens - 128;
    let tooLong = false;
    const startedAt = all.length;
    let roundTokens = 0;
    // no forced floor of 256: the room that is really left decides, so the answer limit can never push the request past the window
    const sampling = { ...(loops ? loopRetrySampling(opts.sampling, loops) : opts.sampling), max_tokens: Math.max(1, Math.min(opts.sampling.max_tokens, room)) };

    let part = "";
    let held = "";      // the start of a continuation, kept until the repeated tail can be cut
    let flushed = !all.trim();
    let looped = false;
    let thoughtCut = false;
    let thought = 0;
    let checked = all.length;
    const cut = new AbortController();
    if (opts.signal?.aborted) {
      cut.abort();
      return;
    }
    const onAbort = () => cut.abort();
    opts.signal?.addEventListener("abort", onAbort);
    // The loop is taken out of the text and the model starts again from what came before it, with the same messages.
    const loopStart = (): number | null => {
      if (all.length - checked < 40) return null;
      checked = all.length;
      return findLoop(all);
    };
    try {
    for await (const ev of streamChat({ ...opts, messages: fit.messages, sampling, signal: cut.signal, refused }, id)) {
      if (ev.type === "done") {
        total = total ? { ...ev.stats, tokens: total.tokens + ev.stats.tokens, totalSec: Math.round((total.totalSec + ev.stats.totalSec) * 100) / 100, ttftSec: total.ttftSec ?? ev.stats.ttftSec, answerSec: total.answerSec ?? ev.stats.answerSec } : ev.stats;
        finish = ev.stats.finish ?? null;
        roundTokens = ev.stats.tokens;
        continue;
      }
      if (ev.type === "retract") {
        // a fail-fast retry inside the stream took the dead attempt's words back: the answer
        // starts over, and everything kept here (the loop search, the join) starts with it
        all = all.slice(0, ev.keep);
        part = part.slice(0, Math.min(part.length, ev.keep));
        held = "";
        flushed = !all.trim();
        checked = Math.min(checked, all.length);
        thought = 0; // the dead attempt's thinking no longer counts against the limit
        yield ev;
        continue;
      }
      if (ev.type === "thinking" && opts.thinkLimit && !all.trim() && !held) {
        thought += ev.text.length;
        if (thought > opts.thinkLimit) { yield ev; thoughtCut = true; cut.abort(); break; }
      }
      if (ev.type !== "answer") { yield ev; continue; }
      if (flushed) {
        part += ev.text; all += ev.text; yield ev;
        const at = loopStart();
        if (at !== null) {
          all = all.slice(0, at);
          yield { id, type: "retract", keep: at };
          looped = true;
          cut.abort();
          break;
        }
        continue;
      }
      held += ev.text;
      if (held.length < 320) continue;
      flushed = true;
      const joined = joinContinuation(all, held);
      const add = joined.slice(all.length);
      part = held;
      all = joined;
      if (add) yield { id, type: "answer", text: add };
    }
    } catch (e) {
      if (looped || thoughtCut) { /* cut on purpose */ }
      else if (squeeze > 0.4 && !part && !held && !opts.signal?.aborted && isContextOverflow((e as Error).message)) tooLong = true;
      else throw e;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (tooLong) {
      squeeze = Math.round(squeeze * 70) / 100;
      yield { id, type: "notice", text: `The server said the request was too long for its window, so the older messages were folded into a shorter recap and it was sent again.` };
      continue;
    }
    if (thoughtCut) {
      finish = "think-limit";
      yield { id, type: "notice", text: `The model was still thinking after ${opts.thinkLimit!.toLocaleString()} characters, so its thought was cut.` };
      break;
    }
    if (looped) {
      loops++;
      if (loops > MAX_LOOP_RETRIES) {
        finish = "loop";
        yield { id, type: "notice", text: `The model looped ${loops} times in a row, so the looping text was removed and the answer stops before it. A bigger model, or a repeat penalty, may write this part.` };
        break;
      }
      yield { id, type: "notice", text: `The model started repeating itself: that text was removed and it starts again from before it (try ${loops} of ${MAX_LOOP_RETRIES}), with a firmer setting.` };
      continue;
    }
    if (!flushed && held) {
      const joined = joinContinuation(all, held);
      const add = joined.slice(all.length);
      part = held;
      all = joined;
      if (add) yield { id, type: "answer", text: add };
    }
    // why it stopped: the room left for the answer was used up (the window), or the answer limit was reached
    windowBound = finish === "length" && sampling.max_tokens < opts.sampling.max_tokens && roundTokens >= sampling.max_tokens * 0.9;
    stalls = all.length - startedAt < 40 && n > 0 ? stalls + 1 : 0;
    // an unfinished file is continued for as long as it grows; a plain answer only a few times
    const cap = endsOpen(all) ? maxContinues * 4 : maxContinues;
    const more = finish === "length" && all.trim().length > 0 && continues < cap && stalls < 2 && (endsOpen(all) || part.trim().length > 0);
    if (!more) break;
    continues++;
    if (windowBound && !compacted && opts.compact) {
      compacted = true;
      const shorter = await opts.compact(base).catch(() => null);
      if (shorter) { base = shorter; yield { id, type: "notice", text: "The window was full: the earlier messages were summarized to make room, and the answer goes on." }; continue; }
    }
    yield { id, type: "notice", text: `The answer hit the ${windowBound ? "end of the window" : "limit"} and was continued (${continues}).` };
  }
  if (finish === "length" && endsOpen(all)) {
    yield { id, type: "notice", text: windowBound ? "The model's window is full and this file is longer than it can hold in one go. Say “continue”, ask for the file in smaller parts, or use a model with a bigger window." : "The answer was cut before the file was finished. Say “continue” to go on." };
  }
  yield { id, type: "done", stats: { ...(total ?? { ttftSec: null, tokPerSec: null, tokens: 0, totalSec: 0 }), finish } };
}

/** Cleans a model's title: first line, no quotes or trailing punctuation, a handful of words. */
export function cleanTitle(raw: string): string {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const t = line.replace(/^(title|name)\s*:\s*/i, "").replace(/^["'“”‘’`*#\s]+|["'“”‘’`*.!\s]+$/g, "").replace(/\s+/g, " ");
  return t.split(" ").slice(0, 8).join(" ").slice(0, 60);
}

/** The answer text after one more event: an answer adds to it, a retract (the model looped) cuts it back. Anything else leaves it as it was. */
export const withAnswer = (text: string, ev: ChatEvent): string => ev.type === "answer" ? text + ev.text : ev.type === "retract" ? text.slice(0, ev.keep) : text;
