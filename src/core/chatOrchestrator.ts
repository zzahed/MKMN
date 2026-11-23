/**
 * The chat orchestrator, free of window-shell code: every chat request goes through `runChatOrchestrator`,
 * from the Node sidecar's `chat` method. Everything that
 * talks to the machine outside this file — starting a model server, the router server,
 * searching the web, drawing figures, screenshots, the artifact checker — is injected as a
 * `ChatHost`, so the same orchestration (runtime lease, laps, Dynamic teams, sub-agents,
 * websearch, pictures, compaction, reviewer, charts, improve loop) runs under both hosts.
 */
import type { ArtifactKind, CatalogEntry, ChatEvent, ChatMessage, ChatOptions, ComputeTarget, HardwareProfile, ReviewStep, Sampling, Settings, WriterRole } from "../shared/types";
import { readBool, readNum, readObj } from "../shared/settingsSchema";
import * as nodePath from "node:path";
import { existsSync } from "node:fs";
import { CATEGORY_INFO, THINKING_OK, isDynamicId, installedOf, mergedPack, pickModel, sortRequest, tierOf, wantedNote, type BundleModel, type TaskCategory } from "./dynamic";
import { DYNAMIC_DATA } from "./dynamic-data";
import { scoreEntry } from "./fit";
import { scoreOf } from "./scores";
import { routerWanted, withRouter, PRODUCE_VOTES, Q, readSearchQuery, searchQueryPrompt, settled, parseYesNo, yesNoPrompt, type Asked } from "./router";
/** What one router sort came back with (local to the orchestrator in the desktop build; kept identical). */
type RouterResult = { kind: TaskCategory | null; asked: Asked[]; ms: number };
import { withAnswer, cleanTitle, ServerLostError } from "./chat";
import { Gateway, GatewayTurnLimitError } from "./harness/gateway";
import { createLiveRun, type LiveRun } from "./harness/run";
import { currentRun, closeRunScope, openRunScope } from "./harness/current";
import { openTurnBudget, closeTurnBudget, turnBudgetOf } from "./harness/turn";
import { turnBudgetOfSettings } from "./harness/policy";
import { IdentityEventGuard } from "./harness/identity";
import { offloadPayload, offloadSection, offloadThreshold, foldOffloadName, readBack } from "./harness/offload";
import { sString } from "./harness/schema";
import type { StepUsage } from "./harness/journal";
import { journalDir } from "./harness/journal";
import { DEFAULT_ENDPOINT } from "./geniex";
const isFoundryEntry = (e: CatalogEntry) => e.id.startsWith("foundry:");
import { applyEffort, autoEffort, effectiveEffort, stageEffort, thinkingSupport, visionSupport, withSystem } from "./effort";
import { codeSampling } from "./sampling";
import { latestArtifacts, compactHistory, reviewCode, resolveEdits, stripEdits } from "./review";
import { interfaceOf, stepwise, stubHistory, type Session } from "./build";
import { compactConversation, compacted, foldedText, isValidSummary, KEEP_SHARE, planCompaction, recallFolded, requestRoom, wantsCompaction } from "./compaction";
import { digestOf, isFilesMessage, isMemoMessage } from "./memo";
import { promptTokens, tokensOf } from "./context";
import { DESCRIBE_INSTRUCTIONS, describePrompt, describers, imageBlock, imageKey, imageLost, imagesOf, swapImages } from "./vision";
import { documentSourcesOf, hasPdfDocs, locatorMessages, parseLocatorReply, questionOf, resolvePdfDocs } from "./pdfSections";
import { improve } from "./improve";
import { artifactsIn, stripPromptLeak } from "./artifacts";
import { mergeFiles } from "./bundle";
import { routeVisual } from "./visualRoute";
import { templateChart } from "./chartTemplates";
import { CHART_FIX_INSTRUCTIONS, settleCharts, mendLeakedFormulas, chartBlocks, chartFlaw } from "./chart";
import { settleBlocks } from "./blocks";
import { diagramFixInstructions } from "./diagram";
import { prepareTurn } from "./chatPrepare";
import { orchestrate } from "./orchestrate";
import { makeDeck, wantsDeck } from "./deckBuild";
import { changeDeck } from "./deckEdit";
import { kindFrom, makeFromTemplate } from "./templates/build";
import type { TemplateKind } from "./templates/kit";
import { type Pic } from "./slides";
import type { RenderResult } from "./deckBuild";
import { runtimeLease } from "./lease";
import { friendly, ModelStartError } from "./errors";
import { knowledgeBudget, KNOWLEDGE_LEAD } from "./projects";
import { knowledgeDirOf, openKnowledgeIndex, type KnowledgeHit } from "./knowledge/store";
import { filesHashOf, scriptOf, tokenize } from "./knowledge/index";
import type { Embedder } from "./knowledge/embed";
import { openVectorIndex } from "./knowledge/vectors";
import { vectorEmbedder } from "./knowledge/vectorModel";
import { asksOwnership, COVERAGE_MIN, figurePassage, locatorMessagesFor, mergeByBestRank, namesPeriod, outlineLines, ownershipPassage, packSections, placeOf, QUERY_STOP, queryCoverage, STRONG_COVERAGE, STRONG_MAX, STRONG_OUTLINE_CHARS, STRONG_RATIO, type RetrSection } from "./knowledge/retrieve";
import { citeAnswer, citationGuardStep, unsupportedFigures, unsupportedNotice, type CitedSection } from "./cite";
import { FOUNDRY_MIN_TOKENS } from "./benchRunner";
import { appendInstructions, type InstructionBlock, type Relevance } from "./prompts";
import { folderInstructions, type FolderCall } from "./folderTools";
import { runFolderCall } from "./folderRun";
import { ref as entryRef } from "./catalog";

export type Served = {
  endpoint: string;
  /** The resolved cache reference the server was started with: completions name THIS, never the application id. */
  model?: string;
  status(): { nctx: number | null; /** How the served context length is known: "compiled" (baked in, QAIRT-style, not a request limit), "configurable" (--nctx was honored), null (unknown). Additive so every Served producer stays valid. */ contextKind?: "compiled" | "configurable" | null };
};

/**
 * What the app around the orchestrator provides. The host process fills it with
 * its own server managers; the Node sidecar with a roundtrip to the Tauri host, which owns
 * `geniex.exe`. Everything here is plain Node.
 */
export interface ChatHost {
  settings(): Settings;
  /** Merges a settings patch and persists it (a dropped load profile, a placement). */
  patchSettings(patch: Partial<Settings>): void;
  /** Every entry the app knows (catalog + custom + foundry). */
  allEntries(): CatalogEntry[];
  entryById(id: string): CatalogEntry | undefined;
  /** The installed, non-Dynamic, visible entries a chat is sorted against. */
  installedEntries(): Promise<CatalogEntry[]>;
  chatHardware(): Promise<HardwareProfile>;
  lastLoaded(): CatalogEntry | null;
  setLastLoaded(e: CatalogEntry): void;
  benchRunning(): boolean;
  /** Brings a model's server up (switching engines when needed) and returns where it listens. */
  ensureServer(entry: CatalogEntry, o?: { setting?: unknown; force?: boolean; signal?: AbortSignal; retryModelLoad?: boolean }): Promise<Served>;
  /**
   * Puts the model server down and starts it again, through the supervisor that owns it — the
   * fail-fast client's one recovery for a server that stopped serving mid-call. Absent, a
   * stalled call fails without recovery.
   */
  recoverServer?(entry: CatalogEntry): Promise<Served>;
  /** The name a model is asked for in a request (its build id for Foundry, its reference for GenieX). */
  servedName(e: CatalogEntry): string;
  send(ev: ChatEvent): void;
  recordSpeed(e: CatalogEntry, tokPerSec: number | null, tokens: number): void;
  /** The folder a project points at, if any (read from the request: the project lives in the renderer). */
  folderOf(opts: ChatOptions): string | null;
  figure(lang: "mermaid" | "chart", raw: string, signal?: AbortSignal): Promise<Pic | null>;
  /** One slide's page drawn in a hidden window, with what is wrong in it. Absent when this host cannot draw slides: the deck build then judges every slide by the app's own layout measure only and says so, it never claims a render. */
  renderSlide?(html: string): Promise<RenderResult>;
  lookAtShot(id: string, shot: string, question: string, signal: AbortSignal): Promise<string | null>;
  checkArtifact(a: any, all: any, o?: any): Promise<any>;
  /** Keeps the PC awake during a long improve loop; returns the stopper. */
  keepAwake?(): () => void;
  notify?(title: string, body: string): void;
  /** The NPU's way out: stray processes and an automatic reset, when the host can do them. */
  npuRecovery?(): Promise<{ external: string[]; canReset: boolean; reset(): Promise<{ ok: boolean; message: string }> }>;
  /** The last error the model server itself reported, when the host knows one. */
  /**
   * Where the turn's harness journal is written (the host owns the paths). Absent,
   * the default workspace journal is used; `null` runs the turn without a journal.
   */
  harnessJournalFile?(): string | null;
  /**
   * Where a project's knowledge index is kept (the host owns the paths). Absent or
   * null: the index is built in memory from the files the request carries, and
   * nothing is written — the store file is what makes a rebuild unnecessary.
   */
  knowledgeDir?(): string | null;
  /**
   * The multilingual embedder for the knowledge retrieval's vector path, or null when
   * its model is not installed. Absent: the app's own installed model (none in tests).
   */
  embedder?(): Promise<Embedder | null>;
  /** Marks the owned server busy while a generation is in flight (the "busy" state between "ready" and idle). */
  markGeneration?(active: boolean): void;
  /** The router (a small model on the processor): absent, the words alone sort the request. */
  router?: {
    sort(text: string, installed: CatalogEntry[], lean?: TaskCategory): Promise<RouterResult | null>;
    yesNo(text: string, ask: string): Promise<boolean | null>;
    query(text: string): Promise<string | null>;
    fileKind(text: string): Promise<TemplateKind | null | undefined>;
  };
}

// ---------------------------------------------------------------- module state

/** What each image said when it was described, so an image kept in the chat is not looked at again at every message. */
const imageNotes = new Map<string, { text: string; model: string }>();

/** The turns being answered, so the window can stop one (`abortChat`). */
const chats = new Map<string, AbortController>();
/** "Skip this step" / "go back a step" pressed while a turn is being built (`skipStep`). */
const skips = new Map<string, { n: number; action: "skip" | "back" }>();

/** Stops a turn that is being worked on. */
export function abortChat(id: string) { chats.get(id)?.abort(); }
/** Presses skip (or back) for the turn being built; it has no effect when nothing is running. */
export function skipStep(id: string, back?: boolean) { skips.set(id, { n: (skips.get(id)?.n ?? 0) + 1, action: back ? "back" : "skip" }); }
/** How many turns are being answered (the scheduler and the quit path wait for none of them). */
export function chatCount() { return chats.size; }
/** Registers a turn the host runs itself (a scheduled task), so it can be stopped and counted with the rest. */
export function registerChat(id: string, ac: AbortController) { chats.set(id, ac); }
export function unregisterChat(id: string) { chats.delete(id); }

/** Generation marking that survives nesting: a compacting pass runs a completion
 * (collect) inside the answer's own stream, and the mender does the same, so a
 * plain boolean would clear the busy flag while the outer answer is still
 * running. A counter marks only when the LAST generation ends. */
let activeGenerations = 0;
function markGenerationNested(host: ChatHost, active: boolean) {
  activeGenerations = Math.max(0, activeGenerations + (active ? 1 : -1));
  host.markGeneration?.(activeGenerations > 0);
}

/**
 * The compactions that run in the background AFTER an answer (one per conversation,
 * keyed by its convId): the next send never waits for one — a new turn takes the NPU
 * back, and every in-flight background compaction is interrupted, the parts it had
 * finished already kept (the onProgress hand-over). The NPU belongs to the person's
 * next answer first; an interrupted fold runs again after it, from the summary it kept.
 */
const activeCompactions = new Map<string, { ac: AbortController; run: LiveRun }>();

/**
 * The folder the folded turns are kept in for recall: next to the host's journal file when it
 * names one, else the workspace's harness folder (where the default journal lives). Tests pass
 * no journal and must never touch the real workspace, so there the fold is simply not kept.
 */
function foldDirOf(host: ChatHost): string | null {
  const jf = host.harnessJournalFile?.();
  if (jf) return nodePath.join(nodePath.dirname(jf), "offload");
  if (process.env.VITEST) return null;
  return nodePath.join(journalDir(), "offload");
}

/**
 * Replaces the packed knowledge block's body under its lead line. The packed
 * text is `<file name="…">…</file>` parts; a file's body may hold blank lines,
 * so the block's end is found by walking the file bodies — the first blank
 * line that sits outside any `<file>` body is where the packed block ends and
 * the rest of the system prompt begins. The new text (retrieved sections or
 * the whole-document summary, plus the outline) takes the block's place.
 */
function replaceKnowledgeBlock(sys: string, block: string): string {
  const at = sys.indexOf(KNOWLEDGE_LEAD);
  if (at < 0) return sys;
  let i = at + KNOWLEDGE_LEAD.length;
  let depth = 0;
  while (i < sys.length) {
    if (depth === 0 && sys.startsWith("\n\n", i)) break;
    if (depth === 0) {
      const open = sys.indexOf("<file ", i);
      if (open < 0) break; // nothing packed after the lead: the block is the lead alone
      depth = 1;
      i = open + "<file ".length;
    } else {
      const close = sys.indexOf("</file>", i);
      if (close < 0) { i = sys.length; break; }
      depth = 0;
      i = close + "</file>".length;
    }
  }
  return sys.slice(0, at) + block + sys.slice(i);
}

/** Stop every in-flight background compaction: called when a new turn starts (the NPU is about to be needed). */
function stopBackgroundCompactions(): void {
  for (const [, c] of activeCompactions) c.ac.abort();
}

/**
 * The fold that runs after an answer, in the background: when the conversation is past
 * the point where it is summarized, the oldest part is folded NOW, while the person
 * reads — so the next send starts with a request that already fits. It is a run of its
 * own (pipeline "compaction") on the model already loaded: no switch, no wait, and a
 * send that arrives mid-fold interrupts it with what it had finished kept.
 */
function startBackgroundCompaction(host: ChatHost, id: string, convId: string, entry: CatalogEntry, srv: Served, messages: ChatMessage[], memoTurns: number): void {
  const ac = new AbortController();
  const scope = `bg-${String(convId).replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now().toString(36)}`;
  const run = createLiveRun({
    pipeline: "compaction",
    conversationId: convId,
    runId: `compaction-${scope}`,
    journalFile: host.harnessJournalFile?.() ?? (process.env.VITEST ? null : undefined),
  });
  openRunScope(scope, run);
  const onAbort = () => run.cancel("a new message was sent");
  ac.signal.addEventListener("abort", onAbort);
  activeCompactions.set(convId, { ac, run });
  void (async () => {
    let partial: { text: string; turns: number } | null = null;
    try {
      const r = await foldOldMessages(host, scope, entry, srv, messages, memoTurns, ac.signal, false, {
        convId,
        foldDraft: true, // the answer that just ended is history now: it may be folded away like the turns before it
        onProgress: (p) => { partial = p; },
      });
      if (r && "text" in r) host.send({ id, type: "memo", text: r.text, turns: r.turns, conv: convId });
      else if (r) console.log(`[chat] background compaction for ${convId} did not fold: ${r.error}`);
    } catch {
      // interrupted by a new send (or stopped): the parts that finished are kept, the stretch being written is simply not covered yet
    } finally {
      if (ac.signal.aborted && partial) {
        const p = partial as { text: string; turns: number };
        host.send({ id, type: "memo", text: p.text, turns: p.turns, conv: convId });
      }
      activeCompactions.delete(convId);
      ac.signal.removeEventListener("abort", onAbort);
      closeRunScope(scope, run);
      run.finish(ac.signal.aborted ? "a new message was sent" : undefined);
    }
  })();
}

/** The token budget a chat answer may reserve. max_tokens is a ceiling the server
 * carves KV memory out for, not a target — a budget the size of the whole window
 * makes the server refuse contexts it would otherwise serve, and no chat answer
 * needs that much. Bounded worker sessions keep their full budgets (codeSampling). */
const CHAT_TOKENS_CAP = 4096;
function chatSampling(s: Sampling): Sampling {
  return s.max_tokens > CHAT_TOKENS_CAP ? { ...s, max_tokens: CHAT_TOKENS_CAP } : s;
}

/** One completion, collected: the text of the answer only. The model named in the
 * request is the one the server was actually started with (`srv.model`, the resolved
 * cache reference) — never the application id, which the runtime cannot serve.
 * Inside a chat turn every collect is a Step of the turn's run: journaled with its
 * usage and its reply, guarded by the run's hooks, and settled with the turn. */
/**
 * The output limit of a helper call whose answer is a few words (the locator's section
 * numbers, the rewrite's search words). Measured on the installed app: the
 * 4B locator answered in 0.36 s and then repeated "9,10,11,12,3,..." until the model's own
 * limit, past the 45-second window, so every locator turn cost 45 s for nothing. Foundry
 * Local's NPU builds size their cache on prompt + max_tokens and die under 256.
 */
export function shortReplyTokens(entry: Pick<CatalogEntry, "id">, tokens: number): number {
  return isFoundryEntry(entry as CatalogEntry) ? Math.max(tokens, FOUNDRY_MIN_TOKENS) : tokens;
}

export async function collect(host: ChatHost, entry: CatalogEntry, srv: Served, messages: ChatMessage[], id: string, signal: AbortSignal, effort: ChatOptions["effort"], maxTokens?: number): Promise<string> {
  const support = thinkingSupport(entry);
  const e = applyEffort(effort ? effectiveEffort(effort, support) : null, messages, entry);
  markGenerationNested(host, true);
  try {
    const call = {
      endpoint: srv.endpoint || DEFAULT_ENDPOINT, model: srv.model ?? host.servedName(entry), messages: e.messages, id,
      sampling: maxTokens ? { ...codeSampling(entry.sampling), max_tokens: shortReplyTokens(entry, maxTokens) } : codeSampling(entry.sampling), signal, body: e.body, thinkOpen: support === "always", nctx: srv.status().nctx ?? 4096,
      recover: host.recoverServer ? async () => { srv = await host.recoverServer!(entry); return true; } : undefined,
      // Identity is not forced here: these are the orchestrator's own sub-calls — the answer
      // path carries the block already (buildSystemPrompt), and a yes/no classifier question
      // stays minimal.
      identity: false,
    };
    const run = currentRun(id);
    if (!run) return (await new Gateway().ask(call)).text; // not part of a turn (router, bench, NPU test)
    const rec = await run.step({
      id, kind: "model-call",
      // journal-sized input: where the call went and how much it carried, never the prompt text
      input: { model: call.model, messages: e.messages.length },
      schema: sString(),
      outputRetries: 0, transportRetries: 0, // retries stay the caller's policy, as before the run
      exec: async () => {
        const a = await new Gateway().ask(call);
        return { output: a.text, reply: a.text, usage: a.usage };
      },
    });
    if (rec.status !== "ok") throw new Error(rec.error ?? `${id} did not settle ok`);
    return rec.output as string;
  } finally {
    markGenerationNested(host, false);
  }
}

// ---------------------------------------------------------------- helpers

/** Where a model is known to run: what this PC measured, else what the shipped tests saw. Nothing when it was never measured. */
function knownPlacement(host: ChatHost, e: CatalogEntry): "npu" | "hybrid" | "gpu" | "cpu" | undefined {
  const own = host.settings().placements?.[isFoundryEntry(e) ? e.repo : entryRef(e)];
  return own ?? (scoreOf(e)?.runsOn as "npu" | "hybrid" | "gpu" | "cpu" | undefined);
}

/** Dynamic works on the NPU: a model known to run partly or wholly elsewhere is left out, whoever provides it. Only when nothing else of the pack is there is it used, as the way out. */
function onNpuOnly(host: ChatHost, installed: CatalogEntry[], pack: { models: BundleModel[] }): CatalogEntry[] {
  const full = installed.filter((e) => { const on = knownPlacement(host, e); return !on || on === "npu"; });
  return pack.models.some((m) => installedOf(m, full)) ? full : installed;
}

/** The team behind a Dynamic model for one request: what kind of task it is, and the model that does it best. */
export async function dynamicTeam(host: ChatHost, entryId: string, messages: ChatMessage[], useRouter = true) {
  const settings = host.settings();
  const pack = mergedPack(DYNAMIC_DATA, tierOf(entryId), settings.dynamic);
  if (!pack) return null;
  const installed = onNpuOnly(host, await host.installedEntries(), pack);
  const mine = pack.models.flatMap((m) => { const e = installedOf(m, installed); return e ? [e] : []; });
  if (!mine.length) return null;
  const text = (m?: ChatMessage) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(""));
  const users = messages.filter((m) => m.role === "user");
  const last = users.at(-1);
  const hasImage = Array.isArray(last?.content) && last!.content.some((p) => p.type === "image_url");
  const previous = users.length > 1 ? sortRequest(text(users.at(-2)), { hasFiles: false }).category : undefined;
  let sorted = sortRequest(text(last), { hasImage, previous, hasFiles: latestArtifacts(messages).length > 0 });
  // the words decide what they are sure of; the router, a tiny model on the processor, reads the rest
  let routed = false;
  if (useRouter && routerWanted(sorted)) {
    const r = await host.router?.sort(text(last), installed, sorted.category);
    if (r?.kind) { sorted = withRouter(sorted, r.kind); routed = true; }
  }
  // no chat model is ever loaded or asked just to sort a request (that was a model swap on the NPU before the first word): what the words
  // and the router, on the processor, do not settle is a plain chat
  const hw = await host.chatHardware();
  const fits = (e: CatalogEntry) => isFoundryEntry(e) || scoreEntry(e, hw).contextTokens > 0;
  const pick = pickModel(pack, sorted.category, installed, { loaded: host.lastLoaded(), fits });
  if (!pick) return null;
  const label = CATEGORY_INFO[sorted.category as TaskCategory].label;
  const note = `Dynamic ${pack.label} · ${label} → ${pick.entry.name}${wantedNote(pick)}${routed ? " · sorted by the router" : ""}`;
  return { pack, installed, pick, note };
}

/**
 * Images for a model that cannot see them: an installed model that can looks at each one, and the description replaces the image in
 * the message. The model that does the work never knows the difference. Shown as a card, like the other helpers.
 */
async function* describeImages(host: ChatHost, id: string, messages: ChatMessage[], preferred: (CatalogEntry | null | undefined)[], signal: AbortSignal): AsyncGenerator<ChatEvent, ChatMessage[]> {
  const refs = imagesOf(messages);
  if (!refs.length) return messages;
  const installed = await host.installedEntries();
  const options = describers(installed, host.lastLoaded(), preferred);
  const question = (() => { const last = [...messages].reverse().find((m) => m.role === "user"); return !last ? "" : typeof last.content === "string" ? last.content : last.content.map((p) => (p.type === "text" ? p.text : "")).join(""); })();
  const fresh = refs.filter((r, i) => !imageNotes.has(imageKey(r.url)) && refs.findIndex((x) => imageKey(x.url) === imageKey(r.url)) === i);
  const failures = new Map<string, string>();
  if (fresh.length && !options.length) {
    for (const r of fresh) failures.set(imageKey(r.url), "no installed model can see images (install a vision model in Models, for example one with VL in its name)");
  } else {
    for (const [k, r] of fresh.entries()) {
      const key = imageKey(r.url);
      const card = { name: `Image ${k + 1}`, task: "Looking at the image so the model that cannot see it knows what is in it", index: 1002 + k, status: "running" as const, output: "" };
      let why = "";
      for (const d of options) {
        yield { id, type: "agent", agent: { ...card, name: `Image ${k + 1} · ${d.name}`, output: "" } };
        try {
          const srv = await host.ensureServer(d);
          host.setLastLoaded(d);
          const text = (await collect(host, d, srv, [{ role: "system", content: DESCRIBE_INSTRUCTIONS }, { role: "user", content: [{ type: "image_url", image_url: { url: r.url } }, { type: "text", text: describePrompt(question) }] }], `${id}:image:${k}`, signal, "off")).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
          if (!text) throw new Error("it sent no description");
          imageNotes.set(key, { text, model: d.name });
          if (imageNotes.size > 40) imageNotes.delete(imageNotes.keys().next().value as string);
          yield { id, type: "agent", agent: { ...card, name: `Image ${k + 1} · ${d.name}`, status: "done", output: text } };
          why = "";
          break;
        } catch (e) {
          if (signal.aborted) throw e;
          why = (e as Error).message;
          yield { id, type: "agent", agent: { ...card, name: `Image ${k + 1} · ${d.name}`, status: "error", error: why } };
        }
      }
      if (why) failures.set(key, why);
    }
  }
  if (failures.size) yield { id, type: "notice", text: `An image could not be read (${[...failures.values()][0]}), so the answer does not use it.` };
  return swapImages(messages, (r, n) => {
    const note = imageNotes.get(imageKey(r.url));
    return note ? imageBlock(n, note.text, note.model) : imageLost(n, failures.get(imageKey(r.url)) ?? "it could not be described");
  });
}

/**
 * Folds the oldest part of a chat into a summary. `messages` is the request as built (system, chat, the message being answered last).
 * Returns the shorter request and what the summary stands for, or null when there is nothing to fold or the model could not do it.
 *
 * The summary is checked before it is kept (isValidSummary): a reply that is empty, over its share of the
 * window, or a refusal is made once more, and when there is still no usable one, a recap made without a
 * model stands in — the fold always happens, and what it stands for is said honestly.
 *
 * When the conversation has a name (`convId`) and the host keeps a journal, the folded turns are also
 * written to the offload store under a stable name, so a later question about them can recall them
 * (Q.recall); the summary itself is only what the request carries.
 */
export async function foldOldMessages(host: ChatHost, id: string, entry: CatalogEntry, srv: Served, messages: ChatMessage[], memoTurns: number, signal: AbortSignal, show: boolean, keep?: { convId?: string; onProgress?: (p: { text: string; turns: number }) => void; foldDraft?: boolean; timeoutMs?: number }): Promise<{ messages: ChatMessage[]; text: string; turns: number; folded?: string } | { error: string } | null> {
  const nctx = srv.status().nctx ?? 4096;
  const plan = planCompaction(messages, Math.floor(requestRoom(nctx, entry.sampling.max_tokens) * KEEP_SHARE), keep?.foldDraft ?? false);
  if (!plan) return null;
  // the folded turns are kept whole for recall (C5): a file in the fold store, named after the conversation
  let folded: string | undefined;
  const foldDir = foldDirOf(host);
  if (foldDir && keep?.convId) {
    try {
      folded = offloadPayload(foldDir, foldOffloadName(keep.convId), foldedText(plan.head)).file;
    } catch (e) {
      console.error(`[chat] ${id}: the folded turns could not be kept for recall: ${(e as Error).message}`);
    }
  }
  const card = { name: "Freeing up context", task: `Summarizing earlier messages`, index: 1002, kind: "memo" as const, status: "running" as const, output: "" };
  if (show) host.send({ id, type: "agent", agent: { ...card } });
  // a summary that takes too long is not worth the wait: the short recap made without a model takes over.
  // The bound is the person's whole wait on the pre-send fold (the records' real summaries took 4.5-28 s,
  // one usable one took 101 s — the cap stays well above what a real summary needs).
  const sac = new AbortController();
  const stop = () => sac.abort();
  signal.addEventListener("abort", stop);
  const timer = setTimeout(stop, keep?.timeoutMs ?? 120_000);
  const turns = memoTurns + plan.head.filter((m) => !isMemoMessage(m) && !isFilesMessage(m)).length;
  try {
    // the share of the window compactConversation keeps a summary under — the same number its validator works against
    const cap = Math.floor(nctx * 0.2 * 3.2);
    const once = () => compactConversation({
      head: plan.head, windowTokens: nctx, memoTurns, signal: sac.signal,
      ask: (m) => collect(host, entry, srv, m, `${id}:memo`, sac.signal, "off"),
      onStep: (n, of) => { if (show && of > 1) host.send({ id, type: "agent", agent: { ...card, task: `${card.task} (part ${n} of ${of})` } }); },
      onProgress: keep?.onProgress,
    });
    let text = "";
    let why = "";
    // the summary is made at most twice: a run that fails (a refusal or an empty part) or comes back
    // unusable is made once more, and when there is still no usable one, the model-free recap stands in.
    // A run that ran OUT OF TIME is not retried: the budget is spent (the second try inherits an
    // aborted controller and never once completed in the records — the retry only added an aborted
    // call to the journal), so the recap stands in at once.
    for (let tries = 0; tries < 2; tries++) {
      try {
        text = await once();
        if (isValidSummary(text, cap)) { why = ""; break; }
        why = "the summary was not usable";
      } catch (e) {
        if (signal.aborted) throw e; // the turn (or the window) was stopped: no summary is wanted any more
        why = sac.signal.aborted ? "it took too long" : (e as Error).message;
        if (sac.signal.aborted) break;
      }
    }
    let fallback = false;
    if (why || !isValidSummary(text, cap)) {
      // no usable summary after the second try: a recap made without a model stands in, so the fold still happens
      text = `Also mentioned:\n${digestOf(plan.head, cap)}`;
      fallback = true;
    }
    const saved = Math.max(0, promptTokens(plan.head) - tokensOf(text));
    if (show) {
      host.send({ id, type: "agent", agent: { ...card, status: "done", output: text, saved } });
      if (fallback) host.send({ id, type: "notice", text: `The model could not write a summary${why ? ` (${why})` : ""}: a short recap made without a model stands in instead.` });
    }
    return { messages: compacted(plan, text), text, turns, folded };
  } catch (e) {
    if (signal.aborted) throw e;
    const why = sac.signal.aborted ? "it took too long" : (e as Error).message;
    if (show) host.send({ id, type: "agent", agent: { ...card, status: "error", error: why } });
    return { error: why };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
}

/** After the answer: run the artifacts, let the reviewer (or the writer) fix what failed, and send the corrected text. */
async function* reviewAnswer(host: ChatHost, id: string, answer: string, history: ChatMessage[], writer: CatalogEntry, writerSrv: Served, effort: ChatOptions["effort"], signal: AbortSignal, prefix: ReviewStep[]): AsyncGenerator<ChatEvent> {
  const settings = host.settings();
  const reviewer = settings.reviewerModelId ? host.allEntries().find((e) => e.id === settings.reviewerModelId) ?? null : null;
  const request = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const hw = await host.chatHardware();
  const readerCtx = reviewer ? scoreEntry(reviewer, hw).contextTokens || reviewer.recommendedContext : 0;
  yield* reviewCode({
    id, answer, history, signal, prefix,
    vision: reviewer ? visionSupport(reviewer) : false,
    request: typeof request === "string" ? request : request.map((p) => (p.type === "text" ? p.text : "")).join(""),
    rounds: Math.min(3, Math.max(1, readNum(settings, "reviewRounds"))),
    reviewer: reviewer?.name ?? null,
    maxChars: Math.floor(readerCtx * 3.5 * 0.5),
    repairChars: Math.floor((writerSrv.status().nctx ?? 4096) * 2.8 * 0.5),
    contractOf: (f) => interfaceOf(f as Parameters<typeof interfaceOf>[0]),
    check: (a, all) => host.checkArtifact(a, mergeFiles(latestArtifacts(history), all)),
    askReviewer: async (msgs) => collect(host, reviewer!, await host.ensureServer(reviewer!), msgs, `${id}:review`, signal, "high"),
    // the writer may have been swapped out by the reviewer: ensureServer brings it back
    askWriter: async (msgs) => collect(host, writer, reviewer ? await host.ensureServer(writer) : writerSrv, msgs, `${id}:fix`, signal, effort)
  });
}

/**
 * "Fix this" answered with edit blocks: put them into the newest version of the file so the answer holds the whole,
 * corrected file. Edits that do not match the file are not guessed at: the model is asked for the whole file instead.
 */
async function* settleEdits(host: ChatHost, id: string, answer: string, history: ChatMessage[], entry: CatalogEntry, srv: Served, effort: ChatOptions["effort"], signal: AbortSignal, steps: ReviewStep[]): AsyncGenerator<ChatEvent, string> {
  const edited = resolveEdits(answer, history);
  if (!edited) return answer;
  const show = (status: "running" | "done"): ChatEvent => ({ id, type: "review", review: { status, steps: [...steps] } });
  let text = answer;
  if (edited.titles.length) {
    text = edited.text;
    steps.push({ kind: "ok", text: `Edited ${edited.titles.join(", ")} (${edited.total - edited.failed} of ${edited.total} change${edited.total === 1 ? "" : "s"} applied).` });
    yield { id, type: "replace", text };
  }
  if (edited.failed) {
    steps.push({ kind: "error", text: `${edited.failed} change${edited.failed === 1 ? "" : "s"} did not match the file. Asking for the whole file…` });
    yield show("running");
    const full = await collect(host, entry, srv, [...history, { role: "assistant", content: stripEdits(answer) || answer }, {
      role: "user", content: "Your edit did not match the current file, so it was not applied. Send the complete corrected file in an <artifact>, nothing else."
    }], `${id}:redo`, signal, effort);
    if (artifactsIn(full).length) {
      text = `${stripEdits(answer)}\n\n${full}`.trim();
      steps.push({ kind: "ok", text: "Got the whole file." });
      yield { id, type: "replace", text };
    } else steps.push({ kind: "error", text: "No whole file came back; kept the changes that applied." });
  }
  yield show("done");
  return text;
}

// ---------------------------------------------------------------- the orchestrator

/**
 * A streamed model call as a step of the turn's run. The words reach the caller
 * exactly as they arrive (the event queue forwards them live — the UI never
 * waits for the step), while the step record below holds the call's whole reply,
 * its usage and its seconds. The stream's own event flow, retries and recovery
 * are unchanged: the step wraps one call, it does not retry it.
 */
function journaledStream(run: LiveRun | undefined, sid: string, make: () => AsyncGenerator<ChatEvent>): AsyncGenerator<ChatEvent> {
  if (!run) return make(); // not part of a turn (router, bench)
  const queue: (ChatEvent | "eof" | Error)[] = [];
  let wake: (() => void) | null = null;
  const push = (e: ChatEvent | "eof" | Error) => { queue.push(e); const w = wake; wake = null; w?.(); };
  const step = run.step({
    id: sid, kind: "model-call", input: sid, schema: sString(),
    outputRetries: 0, transportRetries: 0,
    exec: async () => {
      let answer = "";
      let usage: StepUsage | undefined;
      // the identity guard rides the stream: every complete sentence is guarded before it
      // can stand on the screen or in the voice, across chunk boundaries (A6), while the
      // words still arrive live — only a sentence that names another model is taken back
      const guard = new IdentityEventGuard(sid);
      try {
        for await (const ev of make()) {
          for (const out of guard.event(ev)) {
            if (out.type === "answer" || out.type === "retract") answer = withAnswer(answer, out);
            else if (out.type === "done") usage = {
              prompt: out.stats.promptTokens ?? 0, output: out.stats.tokens ?? 0,
              measured: !out.stats.tokensEstimated && out.stats.promptTokens !== undefined,
            };
            push(out);
          }
        }
        push("eof");
      } catch (e) {
        push(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
      return { output: answer, reply: answer, ...(usage ? { usage } : {}) };
    },
  });
  return (async function* () {
    for (;;) {
      const e = queue.shift();
      if (e === undefined) { await new Promise<void>((r) => { wake = r; }); continue; }
      if (e === "eof") break;
      if (e instanceof Error) { await step.catch(() => undefined); throw e; }
      yield e;
    }
    const rec = await step;
    if (rec.status !== "ok") throw new Error(rec.error ?? `the call ${sid} did not settle ok`);
  })();
}

/** The chat orchestrator: every chat request goes through this one function, from the IPC handler as from any other entry point. */

/** On the vector path, a locator pick counts only among the five nearest sections. */
const VECTOR_TRUST = 5;

/** "3, 7, 12, 20" or "all" fits in 24 tokens; 3 to 8 search words fit in 48. */
const LOCATOR_TOKENS = 24;
const REWRITE_TOKENS = 48;

/** One decimal, for the diagnostic timings. */
const round1 = (x: number): number => Math.round(x * 10) / 10;
export async function runChatOrchestrator(host: ChatHost, id: string, entryId: string, messages: ChatMessage[], opts: ChatOptions) {
  // a background fold that is still running stands down first: the NPU belongs to this turn
  stopBackgroundCompactions();
  // the runtime lease covers the whole turn, preparations included: the `chats` map alone says nothing until the
  // model server is being started, and a task, a test or a benchmark starting in that window would fight over the NPU
  const lease = runtimeLease.acquire("chat", `Chat ${id}`);
  if (!lease) {
    const who = runtimeLease.currentOwner();
    host.send({
      id, type: "error",
      error: { id: "npu-busy", title: "The NPU is busy", fix: who?.owner === "bench" ? "A benchmark is using the NPU. Stop it in Settings, Developer settings, or wait for it to finish." : "Another task is using the NPU. Wait for it to finish, then send again.", raw: `lease held by: ${who?.label ?? "another task"}` }
    });
    return;
  }
  const ac = new AbortController();
  chats.set(id, ac);
  // The turn is a Run: every model call below (the answer stream, a summary, a
  // locator, a sub-agent, the mender) is a Step of this run — journaled, guarded,
  // settled. The journal file is the host's (its paths); tests pass `null`.
  // Pipelines that run inside the turn (the build, a deck, a template) open their
  // own run on this scope while they work (src/core/harness/current.ts), so their
  // calls journal into their run, not the turn's.
  // The sections the retrieval loads onto the request, as citations name them. The
  // retrieval runs AFTER the run was created, so the citation hook reads this
  // array at step time (a mutable closure, src/core/cite.ts).
  const loadedSections: CitedSection[] = [];
  // The run as the screen draws it: the steps as they settle
  // (onStep, after each is journaled), and once more at the end with the
  // verdict. The budget is the turn's account — every call it made, however deep
  // in a sub-run — while the steps listed are the turn's own.
  // (no SettleOutcome import here: the settle-only scan keeps the harness
  // settle's import to its named sites — this reads the result's shape only)
  const sendRun = (verdict?: { state: string; error?: string }): void => {
    const account = turnBudgetOf(id);
    host.send({
      id, type: "run",
      run: {
        runId: run.runId, pipeline: "chat",
        steps: run.steps.map((s) => ({ seq: s.seq, kind: s.kind, status: s.status, seconds: s.seconds, tokens: s.tokens, ...(s.error ? { error: s.error } : {}) })),
        budget: { calls: account?.calls ?? 0, outputTokens: account?.outputTokens ?? 0, maxCalls: account?.limits.maxCalls ?? 0, maxOutputTokens: account?.limits.maxOutputTokens ?? 0 },
        ...(verdict ? { verdict: { state: verdict.state as "done" | "unresolved" | "failed" | "cancelled", ...(verdict.error ? { error: verdict.error } : {}) } } : {}),
      },
    });
  };
  const run = createLiveRun({
    pipeline: "chat",
    ...(opts.convId ? { conversationId: String(opts.convId) } : {}),
    runId: `chat-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now().toString(36)}`,
    journalFile: host.harnessJournalFile?.() ?? (process.env.VITEST ? null : undefined),
    // the hooks: the identity guard rides first in the run's own hook path, the
    // citation check second (the invented [source N] markers dropped before the
    // answer is journaled or shown)
    hooks: { afterStep: citationGuardStep(loadedSections) },
    onStep: () => sendRun(),
  });
  openRunScope(id, run);
  // The turn's budget account:
  // every model call of this turn — the answer, the fold, the reviewer, the locator,
  // the sub-agents, the build sub-runs — is counted against ONE cap, found by the
  // call id's first segment, the same way the journal scope above is found. The
  // router's tiny CPU calls (id `router:...`) stay outside; a background compaction
  // that outlives the turn is uncounted (it is stopped at the next turn's start).
  // The cap is the policy's: the Settings row's saved tune when it is sane, the
  // measured default otherwise (a bad saved value never disables the guard).
  openTurnBudget(id, turnBudgetOfSettings(host.settings()));
  // A stop marks the turn's run cancelled the moment it happens: the call in flight then
  // settles "interrupted" (the person stopped it) instead of "failed" with the raw abort
  // message — stopped turns in an on-device test run journaled "failed / This operation was aborted",
  // a person's stop read as a hard failure. The turn is ending either way.
  ac.signal.addEventListener("abort", () => run.cancel("the turn was stopped"));
  // what the app does before the first request leaves, step by step: the model's own "first token" starts after all of it
  const t0 = Date.now();
  let lapAt = t0;
  let sentAt: number | null = null;
  const laps: { name: string; sec: number }[] = [];
  // the knowledge retrieval's own stages, in milliseconds, and the one diagnostic line they make (numbers only: never a document's words or a prompt)
  const knowTimes: { indexMs?: number; searchMs?: number; vectorMs?: number; rewriteMs?: number; locatorMs?: number; packMs?: number } = {};
  let knowledgeNote: string | null = null;
  const lap = (name: string) => { const n = Date.now(); const sec = Math.round(((n - lapAt) / 1000) * 100) / 100; lapAt = n; if (sec >= 0.1 && sentAt === null) laps.push({ name, sec }); };
  let endedNote: string | undefined;
  let policyStop: string | undefined;
  try {
    const settings = host.settings();
    // prepare (src/core/chatPrepare.ts): the "/" tool words come off the message, and the turn's tools are decided
    const prepared = prepareTurn(settings, messages, opts);
    messages = prepared.messages;
    const { onCommand, asked, agentsOptIn, useLoop, useCheck, useBuild } = prepared;
    // "Dynamic" is a team: this request is sorted into a kind of task and handed to the team's best installed model for it
    if (host.benchRunning()) throw new Error("A benchmark is using the NPU. Stop it in Settings, Developer settings, or wait for it to finish.");
    let team = isDynamicId(entryId) ? await dynamicTeam(host, entryId, messages, !onCommand) : null;
    lap("Sorting the request");
    let entry = team ? team.pick.entry : host.entryById(entryId);
    if (!entry) throw new Error(isDynamicId(entryId) ? "Install the models of this Dynamic size first (Models, Dynamic)." : "Pick a model first.");
    // an image for a model that cannot see: a model that can describes it first, and the description goes with the message
    if (imagesOf(messages).length && !visionSupport(entry)) {
      const pack = team?.pack;
      const pref = pack && team ? [pickModel(pack, "vision", team.installed)?.entry] : [];
      const described = describeImages(host, id, messages, pref, ac.signal);
      let step = await described.next();
      while (!step.done) { host.send(step.value); step = await described.next(); }
      messages = step.value;
      if (isDynamicId(entryId)) { team = await dynamicTeam(host, entryId, messages, !onCommand); if (team) entry = team.pick.entry; } // sorted again on the words, now that the image is text
      lap("Reading the image");
    }
    // a model that can think is told not to, except for reasoning, maths and plans: its thinking is minutes of waiting for a mail or a page
    let effortNow = team && !THINKING_OK.has(team.pick.category) ? ("off" as const) : opts.effort;
    // Auto: the level is read from the kind of request and its words, no model call; a model that cannot think has nothing to settle
    if (opts.effort === "auto" && thinkingSupport(entry) !== "none") {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const words = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
      const category = team ? team.pick.category : sortRequest(words, { hasFiles: latestArtifacts(messages).length > 0 }).category;
      const auto = autoEffort(category, words);
      effortNow = auto.level;
      host.send({ id, type: "notice", text: `Thinking: ${auto.level} (${auto.why}).` });
    }
    // the default level (Medium) of a model picked by hand: a request the words already show to be plain (a mail, a translation, a chat) is
    // answered without the minutes of thinking; High, Low and Off are the person's own choice and stay
    if (!team && opts.effort === "medium" && thinkingSupport(entry) === "toggle") {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const words = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
      const kind = sortRequest(words, { hasFiles: latestArtifacts(messages).length > 0 });
      if (kind.confidence >= 0.8 && !THINKING_OK.has(kind.category)) {
        effortNow = "off";
        host.send({ id, type: "notice", text: "A plain request: answered without thinking first (choose High to make it think)." });
      }
    }
    // F04: the served object is carried through model switches — `bring()` re-serves
    // and updates it, so every use below (streams, compaction, helper passes) names
    // the model the server ACTUALLY runs now, not the one the chat started with.
    let srv = await host.ensureServer(entry, { signal: ac.signal, retryModelLoad: opts.retryModelLoad });
    // the offload threshold comes from the served window: a step reply over an eighth
    // of it is offloaded to a file next to the journal, the record keeps the preview
    run.setOffload(offloadThreshold(srv.status().nctx ?? 4096));
    lap(`Starting ${entry.name}`);
    host.setLastLoaded(entry);
    ac.signal.throwIfAborted();
    if (team) host.send({ id, type: "notice", text: team.note });
    const support = thinkingSupport(entry);
    const level = effortNow ? effectiveEffort(effortNow, support) : null;
    let lean = compactHistory(messages); // older versions of a file only cost context
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
    const ownership = !opts.buildWanted && hasSources && (ownershipLookup || percentageLookup)
      ? ownershipPassage([...knowledgeFiles, ...attachments], sourceAsk) : null;
    if (!opts.buildWanted && hasSources && (ownershipLookup || ownership)) {
      if (ownership) loadedSections.push(ownership);
      const text = ownership
        ? citeAnswer(`${verification ? "I checked the source again.\n\n" : ""}> ${ownership.passage}\n\n[source 1]`, loadedSections).text
        : "I couldn't verify the ownership percentage from an unambiguous passage in the available documents.";
      await run.step({
        id: `${id}:know`, kind: "retrieve", input: { query: sourceAsk, place: ownership?.place },
        schema: sString(), exec: () => ({ output: text, reply: text }),
      });
      ac.signal.throwIfAborted();
      host.send({ id, type: "answer", text });
      host.send({ id, type: "done", stats: { ttftSec: null, tokPerSec: null, tokens: 0, totalSec: 0 } });
      return;
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
      loadedSections.push(...quotes.map(({ file, place }) => ({ file, place })));
      const lead = verification ? "I checked the source again.\n\n" : "";
      const body = figure.kind === "one"
        ? `> ${figure.passage}\n\n[source 1]`
        : `The sources do not agree on this figure:\n\n${quotes.map((q, i) => `> ${q.passage} [source ${i + 1}]`).join("\n\n")}`;
      const text = citeAnswer(`${lead}${body}`, loadedSections).text;
      await run.step({
        id: `${id}:know`, kind: "retrieve", input: { query: sourceAsk, quoted: figure.kind, places: quotes.map((q) => `${q.file} (${q.place})`), timings: { figureMs: round1(figureMs) } },
        schema: sString(), exec: () => ({ output: text, reply: text }),
      });
      console.log(`[knowledge] ${id}: answered from the source (${figure.kind === "one" ? "one passage" : `${quotes.length} passages that disagree`}) in ${round1(figureMs)} ms, no model call`);
      ac.signal.throwIfAborted();
      host.send({ id, type: "answer", text });
      host.send({ id, type: "done", stats: { ttftSec: null, tokPerSec: null, tokens: 0, totalSec: Math.round((Date.now() - t0) / 10) / 100 } });
      return;
    }
    let memoTurnsNow = opts.memoTurns ?? 0; // how many turns the summary at the start of the conversation stands for
    // the window is filling up: the oldest messages are folded into a summary now, before anything is cut and while nothing is being written
    // (the setting can turn the automatic fold off; "Summarize now" in the chat always works, and the stream's
    // own overflow recovery below is the last resort either way)
    {
      const nctx = srv.status().nctx ?? 4096;
      if (readBool(settings, "autoCompact") && wantsCompaction(stubHistory(lean), nctx, entry.sampling.max_tokens)) {
        const r = await foldOldMessages(host, id, entry, srv, lean, opts.memoTurns ?? 0, ac.signal, true, { convId: opts.convId });
        if (r && "text" in r) {
          lean = r.messages;
          memoTurnsNow = r.turns;
          host.send({ id, type: "memo", text: r.text, turns: r.turns });
          host.send({ id, type: "notice", text: `The conversation was getting long for this model's window: the earliest messages were summarized (${r.turns} in all), and the model keeps reading the summary.` });
        } else if (r) host.send({ id, type: "notice", text: `The earliest messages could not be summarized (${r.error}); a short recap of them is used instead.` });
        lap("Summarizing the conversation");
      }
    }
    if (hasPdfDocs(lean)) {
      // a long PDF is never sent whole: a short locator pass reads its outline and names the sections the question needs
      lean = await resolvePdfDocs(lean, async (doc, question, before) => {
        if (doc.sections.length < 2) return doc.sections.map((_, i) => i);
        const card = { name: `Document: ${doc.name}`, task: "Finding the sections that answer the question", index: 1001, status: "running" as const, output: "" };
        host.send({ id, type: "agent", agent: { ...card } });
        const lac = new AbortController();
        const stopLocator = () => lac.abort();
        ac.signal.addEventListener("abort", stopLocator);
        const timer = setTimeout(stopLocator, 45_000);
        try {
          const found = parseLocatorReply(await collect(host, entry!, srv, locatorMessages(doc.sections, question, before), `${id}:doc`, lac.signal, "off", LOCATOR_TOKENS), doc.sections.length);
          const names = (found ?? []).map((i) => `${i + 1}. ${doc.sections[i].title}`);
          host.send({ id, type: "agent", agent: { ...card, status: "done", output: names.length ? names.join("\n") : found ? "No section needed." : "Matched by keywords." } });
          return found;
        } catch (e) {
          if (ac.signal.aborted) throw e;
          if (lac.signal.aborted) host.send({ id, type: "notice", text: "Document search timed out. Continuing with keyword matches." });
          host.send({ id, type: "agent", agent: { ...card, status: "done", output: "Matched by keywords." } });
          return null;
        } finally { clearTimeout(timer); ac.signal.removeEventListener("abort", stopLocator); }
      }, priorAsk);
    }
    // Sub-agents are offered only when the request needs them: one closed question (`Q.agents`), the same
    // askEither rule as the file builds — the router first, then the chat model, either yes is a yes, and
    // when no model answers the result is no. A greeting or a small question is never given the delegation
    // rules, whatever a small model may invent from them. An explicit /agents command skips the question.
    // Asked only when the option is on, so nobody else pays for an extra model call.
    let useAgents = false;
    if (agentsOptIn) {
      const lastUser = [...lean].reverse().find((m) => m.role === "user");
      const requestText = (typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("")).trim();
      const askModel = async (): Promise<boolean | null> => {
        try {
          const p = yesNoPrompt(requestText, Q.agents);
          return parseYesNo(await collect(host, entry, srv, [{ role: "system", content: p.system }, { role: "user", content: p.user }], `${id}:agents`, ac.signal, "off"));
        } catch (e) {
          if (ac.signal.aborted) throw e;
          return null; // no model answered: the result is no
        }
      };
      const askEither = async (): Promise<boolean | null> => {
        const r = host.router ? await host.router.yesNo(requestText, Q.agents).catch(() => null) : null;
        if (r === true) return true;
        const m = await askModel();
        return m === true ? true : m === false || r === false ? false : null;
      };
      useAgents = asked.has("agents") ? true : (await askEither()) === true;
    }
    // a project can point at a folder on this computer: the model may list, read and search it, nothing else
    const folder = host.folderOf(opts);
    // The tools' instructions (search, pictures, sub-agents, a folder) are the registry's appends: they take
    // what is left of the served window after the whole request so far, and are dropped whole when nothing
    // fits — a tool whose rules do not fit still works, the request just does not carry its rules.
    const ctxTokens = srv.status().nctx ?? 4096; // the served window is the one number; 4096 is the host's own default
    const textOf = (m?: ChatMessage) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(""));
    // Recall: when a summary stands for turns that were folded away, and the message asks for
    // something from them, the folded turns are read back from the offload store and the messages whose
    // words answer the question ride with the request. One closed question (Q.recall) decides — the router
    // first, then the chat model, either yes is a yes; when no model answers, the result is no, like every
    // other closed question. Nothing is recalled when there is no fold (no summary, no conversation name,
    // or no kept fold: tests and runs without a journal).
    if (memoTurnsNow > 0 && opts.convId) {
      const foldDir = foldDirOf(host);
      const foldFile = foldDir ? nodePath.join(foldDir, foldOffloadName(opts.convId)) : null;
      if (foldFile && existsSync(foldFile)) {
        const lastUser = [...lean].reverse().find((m) => m.role === "user");
        const question = textOf(lastUser);
        if (question.trim()) {
          const askFold = async (): Promise<boolean | null> => {
            try {
              const p = yesNoPrompt(question, Q.recall);
              return parseYesNo(await collect(host, entry, srv, [{ role: "system", content: p.system }, { role: "user", content: p.user }], `${id}:recall`, ac.signal, "off"));
            } catch (e) {
              if (ac.signal.aborted) throw e;
              return null; // no model answered: the result is no
            }
          };
          const routedFold = host.router ? await host.router.yesNo(question, Q.recall).catch(() => null) : null;
          const want = routedFold === true || (routedFold !== false && (await askFold()) === true);
          const budget = Math.max(1500, Math.floor(knowledgeBudget(ctxTokens) / 2));
          const recalled = want ? recallFolded(readBack(foldFile).text, question, budget) : "";
          // the recall is a step of the turn's run, like every retrieval: what was sought, what answered
          await run.step({
            id: `${id}:recall`, kind: "retrieve",
            input: { conv: opts.convId, fold: foldOffloadName(opts.convId), asked: want, questionChars: question.length, budget, recalledChars: recalled.length },
            schema: sString(), outputRetries: 0, transportRetries: 0,
            exec: () => ({ output: recalled, reply: recalled }),
          });
          if (recalled) {
            const at = lean.map((m) => m.role).lastIndexOf("user");
            lean = lean.map((m, i) => (i === at && typeof m.content === "string" ? { ...m, content: `${m.content}\n\n<recalled from the earlier conversation>\n${recalled}\n</recalled>` } : m));
          }
        }
      }
    }
    // Knowledge retrieval: when the project's knowledge files ride with the
    // request and are too big to pack whole, the sections this question needs are retrieved —
    // the BM25 top 12, then the locator (through the gateway) naming up to 4 to load; the
    // locator's picks ride first and the BM25 rank order fills the knowledge budget whatever
    // the locator answers (an empty or "none" answer never empties the block), most
    // relevant first. The whole
    // document, when the locator says the question is about all of it, goes map-reduce over
    // the sections. Nothing retrieved: today's packing is sent unchanged.
    ac.signal.throwIfAborted();
    const knowlDir = host.knowledgeDir?.() ?? (process.env.VITEST ? null : knowledgeDirOf());
    if (knowledgeFiles.length && opts.projectId && knowledgeFiles.reduce((n, f) => n + f.content.length, 0) > knowledgeBudget(ctxTokens)) {
      const lastUserAt = lean.map((m) => m.role).lastIndexOf("user");
      const question = priorAsk || (lastUserAt >= 0 ? questionOf(lean[lastUserAt]) : "");
      if (question.trim()) {
        const kbBudget = knowledgeBudget(ctxTokens);
        const tIndex = performance.now();
        const index = openKnowledgeIndex(knowlDir, opts.projectId, knowledgeFiles);
        knowTimes.indexMs = performance.now() - tIndex;
        const asRetr = (d: KnowledgeHit): RetrSection => ({ doc: d.doc, fileId: d.fileId, file: d.name, title: d.title, text: d.text, page: d.page, slide: d.slide, sheet: d.sheet, rowFrom: d.rowFrom, rowTo: d.rowTo, scanned: d.scanned });
        const sections: RetrSection[] = index.sections().map(asRetr);
        const card = { name: `Knowledge: ${question.slice(0, 40)}`, task: "Finding the sections that answer the question", index: 1002, status: "running" as const, output: "" };
        host.send({ id, type: "agent", agent: { ...card } });
        // the query: the question's own words; when they match nothing (or feebly — a top
        // score under 1 is one ubiquitous word, nothing to load a section for; or feebly
        // still — the top hit shares too few of the question's own words, a cross-language
        // question whose words cannot meet the files, or a match riding one generic word),
        // one rewrite (the router first, then the chat model) writes search words in the
        // files' language. A question whose SCRIPT differs from the files' (read from the
        // characters, never a model) always earns the rewrite, even when the
        // raw search scored well on a stray Latin word; the rewrite's words are then
        // searched ALONGSIDE the question's own and the two hit lists merge by best rank,
        // so a bad rewrite cannot throw good matches away. When neither model answers, the
        // files' own title and heading words that match the question are searched instead.
        let query = question;
        const tSearch = performance.now();
        let hits = index.search(query, 12);
        knowTimes.searchMs = performance.now() - tSearch;
        // The scripts on this request, read per file: a question's words can
        // never meet the sections of a file written in another script, so whether the
        // scripts cross is a fact about EACH file, never about the corpus's majority —
        // the old corpus-majority reading made an English question over a mostly-
        // English project with one Arabic file not a crossing at all, and the rewrite
        // earned its chance only through the weak-coverage gate (the recorded
        // know-cross-01..03 rode cov 0.27/0.14/0.13 against the 0.3 floor; one word
        // stronger and no rewrite would ever have run).
        const qScript = scriptOf(question);
        const fileScripts = knowledgeFiles.map((f) => ({ name: f.name, script: scriptOf(f.content) }));
        const scriptName = (s: string): string => (s === "ar" ? "Arabic script" : s === "en" ? "Latin script" : "no letters");
        const crossScript = qScript !== "" && fileScripts.some((f) => f.script !== "" && f.script !== qScript);
        const weak = !hits.length || hits[0].score < 1 || queryCoverage(question, hits[0].text) < COVERAGE_MIN;
        // A strong keyword match: the top hit is in a file of the question's own
        // script and holds most of the question's subject words by weight. Then the locator
        // and the rewrite add nothing but a model call each (measured on the retrieval
        // benchmark, every such hit was the supporting section) and the request carries the
        // matched sections, not a full budget of others. A weak, cross-script, ambiguous or
        // several-part question keeps the rewrite and the locator.
        const topScript = hits.length ? (fileScripts.find((f) => f.name === hits[0].name)?.script ?? "") : "";
        const strength = hits.length ? index.coverage(question, hits[0].doc, QUERY_STOP) : 0;
        const strong = !weak && (qScript === "" || topScript === qScript) && strength >= STRONG_COVERAGE;
        let rewriteSource: string | null = null;
        // The vector path: a question BM25 does not match strongly is searched
        // by meaning with the multilingual model when it is installed. Measured on the
        // retrieval benchmark, it kept every supporting section in the top five where BM25
        // kept 85 %, cross-language questions included; on the installed 4B the rewrite it
        // replaces wrote digits. A failure of the model falls back to the rewrite path.
        let vectorInfo: { model: string; source: string; top: number } | null = null;
        if (!strong) {
          const tVec = performance.now();
          try {
            const embedder = host.embedder ? await host.embedder() : (process.env.VITEST ? null : await vectorEmbedder());
            if (embedder) {
              const vindex = await openVectorIndex(knowlDir, opts.projectId, filesHashOf(knowledgeFiles), index.sections(), embedder);
              const [qv] = await embedder.embed([question]);
              const near = vindex.search(qv, 12);
              const all = index.sections();
              hits = near.map((n) => ({ ...all[n.doc], score: n.score }));
              vectorInfo = { model: embedder.id, source: vindex.source, top: Math.round((near[0]?.score ?? 0) * 1000) / 1000 };
              rewriteSource = "vectors";
              query = question;
            }
          } catch (e) {
            if (ac.signal.aborted) throw e;
            console.error(`[knowledge] ${id}: the vector search failed, using the rewrite: ${(e as Error).message}`);
          }
          if (vectorInfo) knowTimes.vectorMs = performance.now() - tVec;
        }
        if (!strong && !vectorInfo && (crossScript || weak)) {
          const tRewrite = performance.now();
          // the rewrite gets the locator's 45-second window too: on the installed 4B
          // one rewrite streamed digits for 230 s, and a first token can take half a minute
          const rac = new AbortController();
          const stopRewrite = () => rac.abort();
          ac.signal.addEventListener("abort", stopRewrite);
          const rewriteTimer = setTimeout(stopRewrite, 45_000);
          try {
            const routed = host.router ? await host.router.query(question).catch(() => null) : null;
            const words = routed?.trim() || await collect(host, entry, srv, [
              { role: "system", content: "You write search words. You are given a question and the files it may be answered from, each file named with the script its words are written in. Reply with only 3 to 8 search words that would find the answer in those files, written in the script of the file that holds the answer — the question may be written in another script, so do not copy the question's language. No explanation, no quotes." },
              { role: "user", content: `Files: ${fileScripts.map((f) => `${f.name} (${scriptName(f.script)})`).join(", ")}\n\nQuestion: ${question}\n\nSearch words:` },
            ], `${id}:knowq`, rac.signal, "off", REWRITE_TOKENS);
            const wordsClean = words.replace(/^[\"'\s]+|[\"'\s]+$/g, "").split("\n")[0].slice(0, 200);
            // A rewrite counts only when its words FIND something: words that match nothing
            // (or that are in none of the files' scripts on a crossing) must not suppress
            // the titles fallback below.
            const rewriteHits = wordsClean && wordsClean !== question ? index.search(wordsClean, 12) : [];
            const wordsScript = scriptOf(wordsClean);
            const wrongScript = crossScript && wordsScript !== "" && !fileScripts.some((f) => f.script === wordsScript);
            if (rewriteHits.length && !wrongScript) {
              rewriteSource = routed?.trim() ? "router" : "model";
              query = wordsClean;
              hits = mergeByBestRank(hits, rewriteHits, (h) => h.doc, 12);
            }
          } catch (e) {
            if (ac.signal.aborted) throw e;
            // no answer from either model (or none in time): fall through to the files' own words
          } finally { clearTimeout(rewriteTimer); ac.signal.removeEventListener("abort", stopRewrite); }
          if (!rewriteSource) {
            const asked = new Set(tokenize(question));
            const words = [...new Set(sections.flatMap((s) => tokenize(s.title)))]
              .filter((w) => asked.has(w))
              .slice(0, 12)
              .join(" ");
            rewriteSource = "titles";
            if (words) hits = mergeByBestRank(hits, index.search(words, 12), (h) => h.doc, 12);
          }
          knowTimes.rewriteMs = performance.now() - tRewrite;
        }
        // the locator reads the shortlist's outline (nothing scored: the whole outline, capped) and names up to 4 sections
        const shortlist: RetrSection[] = hits.length ? hits.map(asRetr) : sections;
        let locatorReply: string | null = null;
        let picked: number[] | null = null;
        if (strong) {
          // the strong path: the hits that scored near the top ride, best first, no locator call
          picked = hits.map((h, i) => ({ h, i })).filter(({ h }) => h.score >= hits[0].score * STRONG_RATIO).slice(0, STRONG_MAX).map(({ i }) => i);
        } else if (sections.length >= 2) {
          const tLocate = performance.now();
          // the locator gets the same 45-second window the attached-PDF locator has: a hung
          // small model must not stall the turn, the ranked order takes over
          const lac = new AbortController();
          const stopLocator = () => lac.abort();
          ac.signal.addEventListener("abort", stopLocator);
          const timer = setTimeout(stopLocator, 45_000);
          try {
            const prevUser = [...lean.slice(0, lastUserAt)].reverse().find((m) => m.role === "user");
            const before = prevUser ? questionOf(prevUser) : "";
            locatorReply = await collect(host, entry, srv, locatorMessagesFor(shortlist, query, before, kbBudget), `${id}:locate`, lac.signal, "off", LOCATOR_TOKENS);
            picked = parseLocatorReply(locatorReply, shortlist.length);
            // on the vector path the locator may only reorder the five nearest sections: the
            // installed 4B counted "22, 23, 24, ..." and its first pick filled the budget
            if (vectorInfo && picked) picked = picked.filter((i) => i < VECTOR_TRUST);
          } catch (e) {
            if (ac.signal.aborted) throw e;
            if (lac.signal.aborted) host.send({ id, type: "notice", text: "Document search timed out. Continuing with keyword matches." });
            picked = null; // the locator could not answer: the ranking's own order is the fallback
          } finally { clearTimeout(timer); ac.signal.removeEventListener("abort", stopLocator); knowTimes.locatorMs = performance.now() - tLocate; }
        } else picked = sections.length ? [0] : [];
        // "all" from the locator means the question is about the whole material: map-reduce.
        // The thinking tags (a thinking model may wrap its reply) are stripped first; the
        // words are the attached-PDF locator's own reply contract.
        const whole = /^ *(all)\b/.test((locatorReply ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim().toLowerCase());
        let body = "";
        let used = 0;
        let leftOut = 0;
        let loadedDocs = new Set<number>();
        if (whole) {
          // "Summarise the whole document": map-reduce over the sections, journaled — the
          // parts summarized (at most 8 calls, grouped to size), the reduce written once,
          // and the summary rides in the block where the sections would have been
          const target = Math.max(3000, Math.ceil(sections.reduce((n, s) => n + s.text.length, 0) / 8));
          const parts: RetrSection[][] = [];
          let cur: RetrSection[] = [];
          let size = 0;
          for (const s of sections) {
            cur.push(s); size += s.text.length;
            if (size >= target) { parts.push(cur); cur = []; size = 0; }
          }
          if (cur.length) parts.push(cur);
          const summaries: string[] = [];
          for (const [n, part] of parts.entries()) {
            try {
              summaries.push(await collect(host, entry, srv, [
                { role: "system", content: "You summarize one part of a longer document. Reply with at most 120 words carrying the part's own content; no preamble." },
                { role: "user", content: `Document: ${knowledgeFiles.map((f) => f.name).join(", ")}\nPart ${n + 1} of ${parts.length}:\n\n${part.map((s) => `- ${s.title} (${placeOf(s)})\n${s.text}`).join("\n\n")}` },
              ], `${id}:docsum-${n + 1}`, ac.signal, "off"));
            } catch (e) {
              if (ac.signal.aborted) throw e;
              summaries.push(`(part ${n + 1} could not be summarized)`); // the reduce knows a part is missing
            }
          }
          if (summaries.length) {
            try {
              body = `<summary of the files, made part by part>\n${(await collect(host, entry, srv, [
                { role: "system", content: "You write the summary of a whole document from the summaries of its parts. Reply with the summary only, at most 200 words." },
                { role: "user", content: `Document: ${knowledgeFiles.map((f) => f.name).join(", ")}\n\n${summaries.map((s, i) => `Part ${i + 1}: ${s}`).join("\n\n")}` },
              ], `${id}:docreduce`, ac.signal, "off")).trim().slice(0, 4000)}\n</summary>`;
              used = body.length;
            } catch (e) { if (ac.signal.aborted) throw e; }
          }
        } else {
          // whatever the locator answers, the BM25 order fills the budget: the
          // locator's valid picks ride first, then every shortlist position the picks left
          // out, in the rank the shortlist already carries — an empty reply, "none", unknown
          // ids, a thrown locator or a lone tiny section never empty the block, and the
          // request never carries less knowledge than the packing would have sent
          const tPack = performance.now();
          const named = picked?.length ? picked : [];
          // the strong path packs only what it matched; the locator path fills the budget in BM25 order
          const picks = strong ? named : [...named, ...shortlist.map((_, i) => i).filter((i) => !named.includes(i))];
          loadedDocs = new Set(picks.map((i) => shortlist[i]?.doc).filter((d): d is number => d !== undefined));
          const packed = packSections(shortlist, picks, kbBudget);
          body = packed.body; used = packed.used; leftOut = packed.leftOut;
          // Only what RODE counts as loaded: a section that did not fit the budget is
          // neither reported as picked nor hidden from the outline of the other sections.
          loadedDocs = new Set(packed.loadedIdx.map((i) => shortlist[i]?.doc).filter((d): d is number => d !== undefined));
          // what actually rode, in source order: the citation check reads this
          loadedSections.push(...packed.loaded);
          knowTimes.packMs = performance.now() - tPack;
        }
        // the block is rebuilt under the same lead the packing used, so the replace below is exact
        let rest = "";
        let knowlOffload: { name: string; bytes: number } | null = null;
        if (body) {
          const outlineRoom = Math.max(0, kbBudget - used);
          const outline = whole
            ? outlineLines(sections, new Set<number>(), outlineRoom)
            : outlineLines(sections, loadedDocs, strong ? Math.min(outlineRoom, STRONG_OUTLINE_CHARS) : outlineRoom);
          if (outline.lines.length) rest += `\nOther sections in the files (name one and its text can be loaded):\n${outline.lines.join("\n")}`;
          if (outline.overflow > 0 || leftOut > 0) {
            const foldDir = foldDirOf(host);
            if (foldDir) {
              const full = sections.map((s) => `- ${s.file} — ${s.title} (${placeOf(s)})`).join("\n");
              const ref = offloadPayload(foldDir, `knowledge-${String(opts.projectId).replace(/[^A-Za-z0-9._-]/g, "_")}`, full);
              rest += `\n[${outline.overflow > 0 ? `${outline.overflow} more sections are listed` : "the sections left out"} in the offload store: ${ref.file}]`;
              knowlOffload = offloadSection(ref);
            }
          }
          const block = `${KNOWLEDGE_LEAD}\n${body}${rest}`;
          // The block rides in the system message's own knowledge block — but the caller may
          // send no system message at all (a bare sidecar call, a headless task): then there
          // is nothing to replace, and dropping the whole retrieval silently is what on-device
          // knowledge turns did (the know step's reply held the fact, the model's request did
          // not, and the model invented facts under the citation instruction). The block the
          // retrieval just built is never dropped: it replaces the packed block, or rides as
          // the request's own system message.
          const sysAt = lean.findIndex((m) => m.role === "system" && typeof m.content === "string" && m.content.includes(KNOWLEDGE_LEAD));
          if (sysAt >= 0) lean = lean.map((m, i) => (i === sysAt ? { ...m, content: replaceKnowledgeBlock(m.content as string, block) } : m));
          else lean = [{ role: "system", content: block }, ...lean];
          host.send({ id, type: "agent", agent: { ...card, status: "done", output: whole ? "Summary of the whole document." : strong ? [...loadedDocs].map((d) => { const s = sections[d]; return s ? `${s.file} — ${s.title} (${placeOf(s)})` : ""; }).filter(Boolean).join("\n") || "Matched by keywords." : (picked ?? []).filter((i) => shortlist[i]?.doc !== undefined && loadedDocs.has(shortlist[i].doc as number)).map((i) => `${shortlist[i]?.file} — ${shortlist[i]?.title} (${placeOf(shortlist[i])})`).join("\n") || "Matched by keywords." } });
        } else {
          // nothing retrieved: today's packing is sent unchanged
          host.send({ id, type: "agent", agent: { ...card, status: "done", output: "Nothing found in the files." } });
        }
        // the retrieval is a step of the turn's run, like every retrieval: what was sought, what answered
        await run.step({
          id: `${id}:know`, kind: "retrieve",
          input: {
            query, rewritten: rewriteSource !== null, rewrite: rewriteSource, crossLanguage: crossScript, matched: hits.length, sections: sections.length,
            picked: whole ? "all (map-reduce)" : [...loadedDocs].length ? [...loadedDocs] : [],
            blockChars: body.length,
            strong, strength: Math.round(strength * 100) / 100, index: index.source,
            ...(vectorInfo ? { vectors: vectorInfo } : {}),
            timings: Object.fromEntries(Object.entries(knowTimes).map(([k, v]) => [k, round1(v)])),
            ...(knowlOffload ? { offload: knowlOffload } : {}),
          },
          schema: sString(), outputRetries: 0, transportRetries: 0,
          exec: () => ({ output: body || "(nothing retrieved)", reply: body || "(nothing retrieved)" }),
        });
        lap("Searching the knowledge");
        knowledgeNote = `index ${round1(knowTimes.indexMs ?? 0)} ms (${index.source}), search ${round1(knowTimes.searchMs ?? 0)} ms, `
          + `${vectorInfo ? `vectors ${round1(knowTimes.vectorMs ?? 0)} ms (${vectorInfo.source}, top ${vectorInfo.top}), ` : ""}`
          + `${knowTimes.rewriteMs !== undefined ? `rewrite ${round1(knowTimes.rewriteMs)} ms` : "no rewrite"}, `
          + `${strong ? `locator skipped (strong match ${Math.round(strength * 100)}%)` : knowTimes.locatorMs !== undefined ? `locator ${round1(knowTimes.locatorMs)} ms` : "no locator"}, `
          + `${loadedDocs.size} sections, ${body.length} characters`;
      }
    }
    if ((verification || percentageLookup || periodLookup) && hasSources) {
      lean = withSystem(lean, "Check the source text directly. Treat earlier assistant replies as unverified. For every percentage, amount, date or reported figure, quote and cite the passage that explicitly links it to the named entity and, when one is named, its reporting period. If the passages disagree, say so and quote each. If the source is missing or inconclusive, say you could not verify the figure.");
    }
    const appendRel: Relevance = { artifacts: false, office: false, drawn: false, visual: null, web: false, images: false, agents: useAgents, citations: loadedSections.length > 0 };
    const appendExtras: InstructionBlock[] = folder ? [{ name: "folder", priority: 52, when: () => true, text: folderInstructions(folder) }] : [];
    // `lean` already carries the renderer's system message: measuring it once is the whole request so far.
    const appends = appendInstructions(appendRel, ctxTokens, promptTokens(lean), appendExtras);
    if (appends.dropped.length) console.log(`[chat] ${id}: window ${ctxTokens}: tool instructions ${appends.tokens} tokens; left out: ${appends.dropped.join(", ")}`);
    const withAppends = (ms: ChatMessage[]) => (appends.text ? withSystem(ms, appends.text) : ms);
    const base = withAppends(lean);
    const readChars = Math.max(4000, Math.floor(knowledgeBudget(ctxTokens) / 2));
    const lookInFolder = folder ? (call: FolderCall) => runFolderCall(folder, call, readChars) : undefined;
    const nameChat = async () => {
      // a short real name instead of a cut-off copy of the message, asked once the answer is there: it used to come first and every new chat waited for it
      if (!opts.title) return;
      try {
        const first = textOf(messages.filter((m) => m.role === "user").at(-1)).slice(0, 1200);
        if (first.trim()) {
          const tac = new AbortController();
          const stop = () => tac.abort();
          ac.signal.addEventListener("abort", stop);
          const timer = setTimeout(stop, 8_000);
          try {
            const raw = await collect(host, entry, srv, [
              { role: "system", content: "You name chats. Reply with a title of 2 to 6 words that says what the conversation is about. No quotes, no ending punctuation, no explanation. Use the language of the message." },
              { role: "user", content: `Name this chat. First message:\n\n${first}` }
            ], `${id}:title`, tac.signal, "off");
            const name = cleanTitle(raw);
            if (name) host.send({ id, type: "title", text: name });
          } finally { clearTimeout(timer); ac.signal.removeEventListener("abort", stop); }
        }
      } catch { /* the message-based title stays */ }
    };
    lap("Reading the conversation");
    // sub-agents think briefly where they can: they run one after another on the same NPU
    // A role (the planner, the page, the stylesheet, the script) can have a model of its own. The NPU holds one model at a
    // time, so it is switched only when the model of the next session differs from the one that is loaded.
    let loaded = entry;
    let lastSpeed: number | null = null; // tokens per second of the latest session: decides whether a mending session may think
    const routed = (role?: WriterRole): CatalogEntry => {
      // a build stays on the one model chosen for the request: every switch is a load, and the planner, the writers and the mender must agree
      if (team) return entry;
      const rid = role ? host.settings().writers?.[role] : undefined;
      return (rid && host.entryById(rid)) || entry;
    };
    const bring = async (e: CatalogEntry) => { if (e !== loaded) { srv = await host.ensureServer(e); loaded = e; host.setLastLoaded(e); } };
    const rawStream = async function* (sid: string, msgs: ChatMessage[], worker: boolean, role?: WriterRole, schema?: object): AsyncGenerator<ChatEvent> {
      try {
      const re = routed(role);
      await bring(re);
      // The busy mark comes AFTER the model load, not before: `bring()` runs
      // under the startup lock (loads serialize everywhere), and only once the
      // server actually serves the model does the busy flag become a LEASE the
      // benchmark and other external changes must respect. Marking before the
      // load made the load itself look like a generation: a benchmark admitted
      // during it killed the very generation that was starting (C04).
      markGenerationNested(host, true);
      lap("Preparing the request");
      sentAt ??= Date.now();
      const rsupport = thinkingSupport(re);
      const e = applyEffort(worker ? effectiveEffort(stageEffort(sid, lastSpeed), rsupport) : (effortNow ? effectiveEffort(effortNow, rsupport) : null), msgs, re);
      // the gateway: the 45 s stall window, the one recovery through the server's owner.
      // Identity is not forced here: every route's prompt is assembled upstream
      // (buildSystemPrompt carries the block) and a sub-agent or classifier prompt is its own role.
      for await (const ev of new Gateway().stream({ endpoint: srv.endpoint || DEFAULT_ENDPOINT, model: srv.model ?? host.servedName(re), messages: e.messages, id: sid, sampling: worker ? codeSampling(re.sampling) : chatSampling(re.sampling), signal: ac.signal, body: schema ? { ...e.body, response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema } } } : e.body, thinkOpen: rsupport === "always", nctx: srv.status().nctx ?? 4096, maxContinues: worker ? 6 : 3, thinkLimit: /:(?:fill|page|siteplan):/.test(sid) ? 1500 : undefined, identity: false,
        // the fail-fast client's one recovery: the server is put down and started again through its owner, and this session's srv points at the new one
        recover: host.recoverServer ? async () => { srv = await host.recoverServer!(re); return true; } : undefined,
        // an answer cut because the window is full folds the older chat into a summary and goes on (a writing session has no chat to fold);
        // like the pre-send fold, this honors the autoCompact setting — the overflow refit is the last resort when it is off
        compact: worker || !readBool(settings, "autoCompact") ? undefined : async (ms) => { const r = await foldOldMessages(host, sid, re, srv, ms, memoTurnsNow, ac.signal, false, { convId: opts.convId }); return r && "text" in r ? r.messages : null; } })) {
        if (ev.type === "done") { host.recordSpeed(re, ev.stats.tokPerSec, ev.stats.tokens); if (ev.stats.tokPerSec) lastSpeed = ev.stats.tokPerSec; }
        yield ev;
      }
      } finally {
        markGenerationNested(host, false);
      }
    };
    // the streamed sessions are steps of the turn's run: the events flow live, the
    // record holds the call (its reply, usage, seconds) for the journal and the hooks
    const stream = (sid: string, msgs: ChatMessage[], worker: boolean, role?: WriterRole, schema?: object): AsyncGenerator<ChatEvent> =>
      journaledStream(currentRun(sid), sid, () => rawStream(sid, msgs, worker, role, schema));
    /**
     * A sub-pipeline of the turn (the program build, a deck, a template) as a run of
     * its own: while it works, its model calls journal into its run (the scope stack,
     * src/core/harness/current.ts), and when it ends, settle() decides its verdict
     * over its own steps. The events it yields are unchanged.
     */
    const scopedRun = async function* <R>(pipeline: string, mk: (sub: LiveRun) => AsyncGenerator<ChatEvent, R>): AsyncGenerator<ChatEvent, R> {
      const sub = createLiveRun({
        pipeline,
        ...(opts.convId ? { conversationId: String(opts.convId) } : {}),
        runId: `${pipeline}-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now().toString(36)}`,
        journalFile: host.harnessJournalFile?.() ?? (process.env.VITEST ? null : undefined),
        offloadBytes: offloadThreshold(srv.status().nctx ?? 4096), // the writer replies (whole files) are the turn's biggest payloads
      });
      openRunScope(id, sub);
      ac.signal.addEventListener("abort", () => sub.cancel("the turn was stopped")); // the build's steps settle interrupted on a stop, not failed
      try {
        return yield* mk(sub);
      } finally {
        closeRunScope(id, sub);
        sub.finish(ac.signal.aborted ? "the turn was stopped" : undefined);
      }
    };
    // A sub-agent works on a run of its own: while the agent's stream is
    // open on the scope, its model calls journal into ITS run (currentRun finds it —
    // the call id's first segment is still the turn's id), and when it ends, settle()
    // decides the agent's verdict over its own steps. The events are unchanged.
    const agentOwnRun = async function* (index: number, mk: () => AsyncGenerator<ChatEvent>): AsyncGenerator<ChatEvent> {
      const sub = createLiveRun({
        pipeline: "agent",
        ...(opts.convId ? { conversationId: String(opts.convId) } : {}),
        runId: `agent-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}-${index}-${Date.now().toString(36)}`,
        journalFile: host.harnessJournalFile?.() ?? (process.env.VITEST ? null : undefined),
        offloadBytes: offloadThreshold(srv.status().nctx ?? 4096),
      });
      openRunScope(id, sub);
      ac.signal.addEventListener("abort", () => sub.cancel("the turn was stopped"));
      try {
        return yield* mk();
      } finally {
        closeRunScope(id, sub);
        sub.finish(ac.signal.aborted ? "the turn was stopped" : undefined);
      }
    };
    // Work on files goes through short sessions of their own (plan, one writer or editor per file, then the explanation),
    // so this conversation never has to carry the code. A chat or a question goes the usual way, with files reduced to stubs.
    const tools = withAppends;
    const turn = async function* (): AsyncGenerator<ChatEvent> {
      const hw = await host.chatHardware();
      const roomOf = (e: CatalogEntry) => scoreEntry(e, hw).contextTokens || e.recommendedContext;
      const smallest = Math.min(ctxTokens, ...(["plan", "html", "css", "js"] as WriterRole[]).map((x) => (host.settings().writers?.[x] && !team ? roomOf(routed(x)) : ctxTokens)));
      // a presentation made from nothing goes through its own steps: plan, text of each slide, visuals, a screenshot of each slide;
      // a change to one that exists goes through the steps of its own too (only the slides concerned are touched)
      const hasDeck = latestArtifacts(lean).some((f) => f.kind === "pptx");
      if (useBuild && (hasDeck || wantsDeck(lean.length ? textOf(lean[lean.length - 1]) : "", false))) {
        // the deck build draws and screenshots slides only when this host really can (a real window);
        // absent, it judges every slide by the app's own layout measure and says so honestly
        const renderSlide = host.renderSlide;
        const deckOpts = {
          id, messages: lean, stream, signal: ac.signal, modelOf: () => routed("plan").name,
          figure: (lang: "mermaid" | "chart", raw: string) => host.figure(lang, raw, ac.signal),
          lookAt: (shot: string, question: string) => host.lookAtShot(id, shot, question, ac.signal),
          ...(renderSlide ? { render: (html: string) => renderSlide(html) } : {}),
          lowPower: !!host.settings().deckLowPower,
        };
        const d = yield* scopedRun("deck", (sub) => (hasDeck ? changeDeck({ ...deckOpts, runSteps: () => sub.steps }) : makeDeck({ ...deckOpts, runSteps: () => sub.steps })));
        await bring(entry);
        if (d.handled) { yield { id, type: "done", stats: d.stats }; return; }
      }
      // a new Word or Excel file goes through a template: the app picks it, the model fills in the fields, the app builds the file
      const lastText = lean.length ? textOf(lean[lean.length - 1]) : "";
      const hasOffice = latestArtifacts(lean).some((f) => f.kind === "docx" || f.kind === "xlsx");
      const hasHtml = latestArtifacts(lean).some((f) => f.kind === "html" || (f.kind === "code" && /^(css|javascript|js)$/i.test(f.language)));
      if (useBuild && kindFrom(await (host.router?.fileKind(lastText) ?? Promise.resolve(undefined)), lastText, hasOffice, hasHtml)) {
        const tpl = yield* scopedRun("template", (sub) => makeFromTemplate({ id, messages: lean, stream, signal: ac.signal, modelOf: () => routed("plan").name, askRouter: (ask) => host.router?.yesNo(lastText, ask) ?? Promise.resolve(null), kindOf: host.router ? host.router.fileKind : async () => undefined, chatHasOffice: hasOffice, chatHasHtml: hasHtml, runSteps: () => sub.steps }));
        await bring(entry);
        if (tpl.handled) { yield { id, type: "done", stats: tpl.stats }; return; }
      }
      // the skill loaded for this request guides the writers of the file too (its rules, and the libraries a page may ask for)
      const skillNote = opts.skillNote?.trim();
      // a session held to a JSON schema (a game description, a site plan) is not given it: "work in this order: design, build, test" leaked into the JSON as keys of its own
      const guided: Session = skillNote ? (sid, ms, worker, role, schema) => stream(sid, schema ? ms : withSystem(ms, skillNote), worker, role, schema) : stream;
      const r = !useBuild ? { handled: false as const, messages: lean } : yield* scopedRun("build", (sub) => stepwise({ id, messages: lean, stream: guided, signal: ac.signal, buildWanted: !!opts.buildWanted, control: () => skips.get(id) ?? { n: 0, action: "skip" as const }, onControl: (action) => sub.rewind(action, action === "back" ? "the person pressed go back a step" : "the person pressed skip this step"), modelOf: (role) => routed(role).name, lookAt: (shot, question) => host.lookAtShot(id, shot, question, ac.signal), askRouter: (ask) => host.router?.yesNo(String(lean[lean.length - 1]?.content ?? ""), ask) ?? Promise.resolve(null), check: (f, all, scenarios) => host.checkArtifact({ t: "artifact", index: 0, title: f.title, kind: f.kind as ArtifactKind, language: f.language, content: f.content, open: false }, all, { probe: true, scenarios }), maxChars: Math.floor(smallest * 2.8 * 0.5), runSteps: () => sub.steps, runGates: (g) => sub.setGates(g) }));
      await bring(entry); // the chat model answers and fixes from here on
      if (r.handled) { yield { id, type: "done", stats: r.stats }; return; }
      // the build gave up on the request: say so, and never silently answer through the chat route
      if (r.reason) yield { id, type: "notice", text: `Planning did not finish: ${r.reason}. Answering directly.` };
      // the note a search added to the request stays; the stubbed conversation is what the model reads
      let msgs = base;
      if (r.messages !== lean) {
        const at = r.messages.map((m) => m.role).lastIndexOf("user");
        const was = lean[lean.map((m) => m.role).lastIndexOf("user")]?.content;
        const now = base[base.map((m) => m.role).lastIndexOf("user")]?.content;
        const note = typeof was === "string" && typeof now === "string" && now.startsWith(was) ? now.slice(was.length) : "";
        const u = r.messages[at];
        msgs = tools(note && typeof u?.content === "string" ? r.messages.map((m, i) => (i === at ? { ...m, content: `${u.content}${note}` } : m)) : r.messages);
      }
      yield* orchestrate({ id, messages: msgs, subagents: useAgents, stream, signal: ac.signal, folder: lookInFolder, ownRun: agentOwnRun });
    };
    let answer = "";
    let done: ChatEvent | null = null;
    for await (const ev of turn()) {
      if (ev.type === "replace") answer = ev.text;
      answer = withAnswer(answer, ev);
      if (ev.type === "done") { done = ev; continue; } // held back: the chat stays busy while the code is checked
      if (ev.type === "error") { host.send(ev); return; }
      host.send(ev);
    }
    if (ac.signal.aborted) throw ac.signal.reason;
    if (!done) throw new Error("The response ended before the model reported completion.");
    if (done) {
      if (done.type === "done") {
        const prepSec = sentAt === null ? null : Math.round(((sentAt - t0) / 1000) * 100) / 100;
        done = { ...done, stats: { ...done.stats, prepSec, prep: laps } };
        // with the wait before the request counted, the word the person saw first is the answer's, not the model's first thought
        if (knowledgeNote) console.log(`[knowledge] ${id}: ${knowledgeNote}; request ${promptTokens(lean)} tokens; first token ${done.stats.ttftSec ?? "?"} s; turn ${Math.round((Date.now() - t0) / 10) / 100} s`);
        if (prepSec !== null && done.stats.answerSec != null && done.stats.answerSec > 2) console.log(`[chat] ${prepSec}s before the request (${laps.map((l) => `${l.name} ${l.sec}s`).join(", ") || "nothing slow"}), then ${done.stats.answerSec}s to the first word (first token ${done.stats.ttftSec}s)`);
      }
      if (!onCommand) await nameChat();
      const steps: ReviewStep[] = [];
      const edits = settleEdits(host, id, answer, base, entry, srv, opts.effort, ac.signal, steps);
      for (let r = await edits.next(); ; r = await edits.next()) {
        if (r.done) { answer = r.value; break; }
        host.send(r.value);
      }
      // the app's own instructions copied into the reply are cut out
      const leak = stripPromptLeak(answer);
      if (leak.stripped) { answer = leak.text; host.send({ id, type: "replace", text: answer }); }
      // the citations stand: markers the request never carried are dropped, the
      // Sources line names what stands (the streamed words went out live; this
      // corrects the message as a whole)
      const cited = citeAnswer(answer, loadedSections);
      if (cited.text !== answer) { answer = cited.text; host.send({ id, type: "replace", text: answer }); }
      // a cited sentence whose figures its cited passage does not hold is named, never rewritten
      const unsupported = unsupportedNotice(unsupportedFigures(answer, loadedSections));
      if (unsupported) host.send({ id, type: "notice", text: unsupported });
      // a known calculator (compound interest, a loan) is drawn from a tested chart when the model wrote none that draws: small models fail at this JSON
      try {
        const lastAsk = [...base].reverse().find((m) => m.role === "user");
        const askText = typeof lastAsk?.content === "string" ? lastAsk.content : (lastAsk?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
        const route = routeVisual(askText);
        const tpl = !onCommand && route && (route.kind === "calculator" || route.kind === "chart" || route.kind === "diagram") ? templateChart(askText) : null;
        if (tpl && !chartBlocks(answer).some((b) => chartFlaw(b.raw) === null)) {
          answer = `${tpl.intro}\n\n${tpl.block}`;
          host.send({ id, type: "replace", text: answer });
          host.send({ id, type: "notice", text: "The model's own drawing could not be used, so a tested calculator was drawn instead." });
        }
      } catch { /* the usual correction below still runs */ }
      // a chart that cannot be drawn is mended before the person sees a red box
      if (!onCommand && /```chart/.test(answer)) {
        try {
          // a chart beyond the usual slips goes to the model the benchmark found best for JSON (the pack's structured-output pick), when the pack has one installed
          const jsonModel = (team ? pickModel(team.pack, "tool_use", team.installed, { loaded: host.lastLoaded() })?.entry : undefined) ?? entry;
          const charts = await settleCharts(answer, async (system, user) => {
            await bring(jsonModel);
            return collect(host, jsonModel, jsonModel === entry ? srv : await host.ensureServer(jsonModel), [{ role: "system", content: system }, { role: "user", content: user }], `${id}:chart`, ac.signal, "off");
          });
          await bring(entry);
          if (charts.text !== answer) { answer = charts.text; host.send({ id, type: "replace", text: answer }); }
          if (charts.mended) host.send({ id, type: "notice", text: `${charts.mended === 1 ? "A chart was" : `${charts.mended} charts were`} mended so that ${charts.mended === 1 ? "it draws" : "they draw"}.` });
          if (charts.left.length) host.send({ id, type: "notice", text: `A chart still cannot be drawn: ${charts.left[0]}.` });
          // placeholders and TeX copied into the sentences around the chart are filled and typeset
          const leaks = mendLeakedFormulas(answer);
          if (leaks.mended) { answer = leaks.text; host.send({ id, type: "replace", text: answer }); }
        } catch (e) { if (ac.signal.aborted) throw e; }
      }
      // a quiz, a sheet, key figures, cards or a list that would not draw as written is corrected the same way
      if (!onCommand && /```(quiz|qcm|mcq|sheet|spreadsheet|kpi|figures|cards|flashcards|checklist|todo)\b/i.test(answer)) {
        try {
          const blocks = await settleBlocks(answer, (system, user) => collect(host, entry, srv, [{ role: "system", content: system }, { role: "user", content: user }], `${id}:block`, ac.signal, "off"));
          if (blocks.text !== answer) { answer = blocks.text; host.send({ id, type: "replace", text: answer }); }
          if (blocks.mended) host.send({ id, type: "notice", text: `${blocks.mended === 1 ? "A block was" : `${blocks.mended} blocks were`} corrected so that ${blocks.mended === 1 ? "it shows" : "they show"} everything.` });
          if (blocks.left.length) host.send({ id, type: "notice", text: `A block still does not show everything: ${blocks.left[0]}.` });
        } catch (e) { if (ac.signal.aborted) throw e; }
      }
      if (useLoop && artifactsIn(answer).length) {
        const stopAwake = host.keepAwake?.(); // the PC may be left alone for a while
        try {
          const lastUser = [...base].reverse().find((m) => m.role === "user");
          const request = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
          const loopSettings = host.settings();
          for await (const ev of improve({
            id, answer, request, signal: ac.signal, direction: loopSettings.agentGoal,
            rounds: Math.min(50, Math.max(1, readNum(loopSettings, "agentRounds"))), endsAt: Date.now() + Math.min(600, Math.max(1, readNum(loopSettings, "agentMinutes"))) * 60_000,
            maxChars: Math.floor(ctxTokens * 2.8 * 0.5),
            check: (a, all) => host.checkArtifact(a, mergeFiles(latestArtifacts(base), all)), askWriter: (msgs) => collect(host, entry, srv, msgs, `${id}:loop`, ac.signal, opts.effort)
          })) {
            if (ev.type === "replace") answer = ev.text;
            host.send(ev);
          }
          host.notify?.("MKMN", "The automatic improvements are finished.");
        } catch (e) {
          if (ac.signal.aborted) throw e;
          host.send({ id, type: "notice", text: `The improve loop stopped: ${(e as Error).message}` });
        } finally {
          stopAwake?.();
        }
      }
      if (useCheck) {
        try {
          for await (const ev of reviewAnswer(host, id, answer, base, entry, srv, opts.effort, ac.signal, steps)) host.send(ev);
        } catch (e) {
          if (ac.signal.aborted) throw e;
          host.send({ id, type: "review", review: { status: "done", steps: [{ kind: "error", text: `The code check failed: ${(e as Error).message}` }] } });
        }
      }
      host.send(done);
      // the fold the NEXT send would need is prepared in the background now, while the person reads:
      // the next send starts with a request that already fits, and never waits for a summary. The model
      // already loaded does the folding (no switch, no lease); a send that arrives mid-fold interrupts it.
      if (readBool(settings, "autoCompact") && !ac.signal.aborted) {
        const post = [...lean, { role: "assistant" as const, content: answer }];
        if (wantsCompaction(stubHistory(post), srv.status().nctx ?? 4096, (loaded ?? entry).sampling.max_tokens)) {
          startBackgroundCompaction(host, id, opts.convId ?? id, loaded ?? entry, srv, post, memoTurnsNow);
        }
      }
    }
  } catch (e) {
    if (ac.signal.aborted) {
      host.send({ id, type: "done", stats: { ttftSec: null, tokPerSec: null, tokens: 0, totalSec: 0 } });
    } else if (e instanceof GatewayTurnLimitError) {
      // the turn's own budget refused a further model call: an honest stop, not a transport
      // fault — the work already done stands, nothing more is sent, and retrying cannot help.
      // The run's verdict says a rule of the app stopped it (unresolved), not the person.
      endedNote = e.message;
      policyStop = e.message;
      const why = e.kind === "calls"
        ? `its model-call budget (${e.limits.maxCalls} calls)`
        : `its output-token budget (${e.limits.maxOutputTokens} tokens)`;
      host.send({ id, type: "notice", text: `This turn reached ${why}, so it stopped calling the model. The answer above is what was gathered; send a new message to continue.` });
      host.send({ id, type: "done", stats: { ttftSec: null, tokPerSec: null, tokens: 0, totalSec: 0 } });
    } else {
      const raw = e instanceof Error ? e.message : String(e);
      const settings = host.settings();
      const last = e instanceof ModelStartError ? e.details : null;
      // a setting kept for this model that crashes the NPU in a real chat is not good: it is dropped, and the model is checked again
      const loadedNow = host.lastLoaded();
      const bad = !last && loadedNow && /dspqueue_read failed|fastrpc_mmap|buffer mapping failed/i.test(raw) ? entryRef(loadedNow) : null;
      let dropped = "";
      if (bad && settings.loadProfiles?.[bad]) {
        dropped = ` The setting kept for this model (${settings.loadProfiles[bad].label}) crashed and was removed.`;
        const { [bad]: _gone, ...rest } = settings.loadProfiles;
        const { [bad]: _b, ...badges } = readObj<Record<string, ComputeTarget>>(settings, "placements");
        host.patchSettings({ loadProfiles: rest, placements: badges });
      }
      let err = last ?? (e instanceof ServerLostError
        ? { id: "model-server-lost", title: "The model server stopped responding", fix: "Try again to resend your request.", raw }
        : friendly(raw) ?? { id: "unknown", title: "Something went wrong", fix: "Try again.", raw });
      const npuFailure = err.id.startsWith("npu-") ||
        (err.id === "model-load" && /^Requested compute: (?:npu|hybrid)$/m.test(err.raw));
      const recovery = npuFailure ? await host.npuRecovery?.().catch(() => undefined) : undefined;
      const contention = recovery?.external.length
        ? ` Windows measured NPU activity from ${recovery.external.join(", ")}. These processes may be sharing the NPU.`
        : "";
      if (/^npu-/.test(err.id) && recovery?.canReset) {
        host.send({ id, type: "notice", text: "The NPU is stuck: resetting it…" });
        const r = await recovery.reset().catch((error: unknown) => ({ ok: false, message: String(error) }));
        err = { ...err, fix: `${err.fix} ${r.ok ? "The NPU was reset automatically: try again." : `The automatic reset did not work: ${r.message}`}` };
      }
      host.send({ id, type: "error", error: { ...err, fix: `${err.fix}${dropped}${contention}` } });
    }
  } finally {
    const outcome = run.finish(policyStop ? undefined : (endedNote ?? (ac.signal.aborted ? "the turn was stopped" : undefined)), policyStop);
    sendRun(outcome); // the last word on the run: the verdict the harness settled (while the budget account still stands)
    closeRunScope(id, run);
    closeTurnBudget(id);
    lease.release();
    chats.delete(id); skips.delete(id);
  }
}
