import type { SlidePick } from "../core/slidePicks";
import type { Memo } from "../core/memo";
import type { AgentRun, Attachment, ChatStats, FriendlyError, BuildRun, LoopRun, ReviewRun, RunView } from "../shared/types";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  stats?: ChatStats;
  error?: FriendlyError;
  pending?: boolean;
  /** The person pressed Stop: the text so far is kept. */
  stopped?: boolean;
  modelName?: string;
  /** Spoken in a voice chat and cut by the person: the text is only what had been said aloud. */
  interrupted?: boolean;
  /** With `interrupted`: how many words of the answer, as the voice reads it, were said aloud. The whole answer is kept. */
  heardWords?: number;
  attachments?: Attachment[];
  /** Slides of a presentation the person pointed at in the preview, in the order chosen. */
  picks?: SlidePick[];
  agents?: AgentRun[];
  review?: ReviewRun;
  loop?: LoopRun;
  build?: BuildRun;
  /** The turn's run as the harness holds it: the steps as they settled, the budget as it stood, the verdict at the end. Live work state — not kept in a saved chat (the journal is the durable record). */
  run?: RunView;
  /** Things done to the request or answer that the person should know (older messages left out, a cut answer continued). */
  notices?: string[];
  /** The build votes split: the answer stands in the chat, and this one action is offered under it ("Build it instead"). */
  offer?: { action: "build"; request: string };
}

export interface Conversation {
  id: string;
  title: string;
  updated: number;
  /** Chats inside a project get its instructions and knowledge. */
  projectId?: string | null;
  /** Kept at the top of the sidebar. */
  pinned?: boolean;
  /** Out of the sidebar lists until restored; the chat itself is kept. */
  archived?: boolean;
  /** True once a proper title was made for it (or the person renamed it). */
  named?: boolean;
  /** What the oldest turns said, kept when they no longer fit the model's window (see core/compaction). */
  memo?: Memo;
  turns: Turn[];
}

const KEY = "opennpu.conversations";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The objects of a saved list (anything else in it is dropped), as the type the field holds. */
const list = <T extends object = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x): x is T => isObj(x)) : []);

/** A build's saved quality score, read back only when it has the shape the card draws (a score in [0, 1], a rubric name, notes as text). */
function cleanQuality(q: unknown): NonNullable<Turn["build"]>["quality"] {
  if (!isObj(q) || typeof q.rubric !== "string" || typeof q.score !== "number" || !Number.isFinite(q.score) || q.score < 0 || q.score > 1) return undefined;
  return { rubric: q.rubric, score: q.score, notes: Array.isArray(q.notes) ? q.notes.filter((n): n is string => typeof n === "string") : [] };
}

/** Saved chats are read back as found: anything malformed is repaired or dropped so one bad value can never stop the app from drawing. */
function cleanTurn(t: Record<string, unknown>): Turn {
  const turn: Turn = { ...t, role: t.role === "user" ? "user" : "assistant", content: typeof t.content === "string" ? t.content : "", pending: false } as Turn;
  if (t.thinking !== undefined && typeof t.thinking !== "string") delete turn.thinking;
  if (t.attachments !== undefined) turn.attachments = list(t.attachments);
  if (t.agents !== undefined) turn.agents = list(t.agents);
  if (t.notices !== undefined) turn.notices = Array.isArray(t.notices) ? t.notices.filter((n: unknown) => typeof n === "string") : undefined;
  if (t.build !== undefined) turn.build = isObj(t.build) && Array.isArray(t.build.steps) ? { status: t.build.status === "unresolved" ? "unresolved" : "done", steps: list(t.build.steps), spec: typeof t.build.spec === "string" ? t.build.spec : undefined, start: Array.isArray(t.build.start) ? list(t.build.start) : undefined, verify: Array.isArray(t.build.verify) ? list(t.build.verify) : undefined, quality: cleanQuality(t.build.quality) } : undefined;
  for (const k of ["review", "loop"] as const) {
    if (t[k] !== undefined && !(isObj(t[k]) && Array.isArray(t[k].steps))) delete turn[k];
  }
  delete turn.run; // live work state: the journal keeps the durable record
  return turn;
}

export function loadConversations(): Conversation[] {
  try {
    return list(JSON.parse(localStorage.getItem(KEY) ?? "[]"))
      .filter((c) => typeof c.id === "string")
      .map((c) => ({ ...c, memo: isObj(c.memo) && typeof c.memo.text === "string" && typeof c.memo.turns === "number" && typeof c.memo.hash === "string" ? c.memo : undefined, title: typeof c.title === "string" ? c.title : "Chat", updated: typeof c.updated === "number" ? c.updated : 0, turns: list(c.turns).map(cleanTurn) }) as Conversation);
  } catch { return []; }
}

export function resetConversations() {
  try { localStorage.removeItem(KEY); } catch { /* blocked */ }
}

/** Saved chats never carry picture bytes that are already in the media store: the id is enough to load them again. */
function cleanAttachments(items: Attachment[] | undefined): Attachment[] | undefined {
  return items?.map((a) => (a.kind === "image" && a.mediaId ? { ...a, dataUrl: undefined } : { ...a }));
}

/** What is written down: no live run state, and picture bytes left to the media store. */
export function persistableConversations(c: Conversation[]): Conversation[] {
  return c.map((x) => ({ ...x, turns: x.turns.map((t) => ({ ...t, pending: false, run: undefined, attachments: cleanAttachments(t.attachments), agents: t.agents?.map((a) => ({ ...a, status: a.status === "running" ? "error" as const : a.status })), review: t.review ? { ...t.review, status: "done" as const, shots: undefined } : undefined, loop: t.loop ? { ...t.loop, status: "done" as const } : undefined, build: t.build ? { status: t.build.status === "running" ? "done" as const : t.build.status, spec: t.build.spec, quality: t.build.quality, start: t.build.start?.map(({ shot, ...v }) => ({ ...v, status: v.status === "running" ? "error" as const : v.status })), verify: t.build.verify?.map(({ shot, ...v }) => ({ ...v, status: v.status === "running" ? "error" as const : v.status })), steps: t.build.steps.map((s) => ({ ...s, status: s.status === "running" || s.status === "waiting" ? "error" as const : s.status, stages: s.stages?.map(({ shot, ...v }) => ({ ...v, status: v.status === "running" ? "error" as const : v.status })) })) } : undefined })) }));
}

/** Last resort when the quota is full: drop picture bytes that were never written to the media store, and say so. */
function withoutInlineMedia(c: Conversation[]): Conversation[] {
  return c.map((x) => ({ ...x, turns: x.turns.map((t) => t.attachments?.some((a) => a.kind === "image" && a.dataUrl && !a.mediaId)
    ? { ...t, attachments: t.attachments.map((a) => (a.kind === "image" && a.dataUrl && !a.mediaId ? { ...a, dataUrl: undefined, unavailable: true } : a)) }
    : t) }));
}

export interface SaveConversationsResult { ok: boolean; droppedMedia?: boolean; error?: string }

/**
 * The write itself, on a list ALREADY made persistable by `persistableConversations`.
 * Split from `saveConversations` so a throttled saver makes the conversations persistable
 * once per save and hands the SAME copy to every writer (this storage and the host's).
 */
export function writePersistableConversations(clean: Conversation[]): SaveConversationsResult {
  try {
    localStorage.setItem(KEY, JSON.stringify(clean));
    return { ok: true };
  } catch {
    // The chats matter more than the leftovers of old pictures: keep them all, mark the bytes as gone.
    try {
      localStorage.setItem(KEY, JSON.stringify(withoutInlineMedia(clean)));
      return { ok: true, droppedMedia: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

export function saveConversations(c: Conversation[]): SaveConversationsResult {
  return writePersistableConversations(persistableConversations(c));
}

/**
 * Older chats kept picture bytes inline. Give each one a file of its own once, so later saves carry an id
 * instead of megabytes of base64 (and a full quota can no longer take the picture away with the chat).
 */
export async function adoptInlineMedia(
  c: Conversation[],
  save: (dataUrl: string) => Promise<{ mediaId: string } | null | undefined>
): Promise<Conversation[]> {
  const urls = new Set<string>();
  for (const conv of c) for (const t of conv.turns) for (const a of t.attachments ?? []) {
    if (a.kind === "image" && a.dataUrl && !a.mediaId) urls.add(a.dataUrl);
  }
  if (!urls.size) return c;
  const ids = new Map<string, string>();
  await Promise.all([...urls].map(async (url) => {
    try { const saved = await save(url); if (saved?.mediaId) ids.set(url, saved.mediaId); } catch { /* it stays inline */ }
  }));
  if (!ids.size) return c;
  const adopt = (a: Attachment) => (a.kind === "image" && a.dataUrl && !a.mediaId && ids.has(a.dataUrl) ? { ...a, mediaId: ids.get(a.dataUrl) } : a);
  return c.map((conv) => ({ ...conv, turns: conv.turns.map((t) => (t.attachments?.some((a) => a.kind === "image" && a.dataUrl && !a.mediaId && ids.has(a.dataUrl)) ? { ...t, attachments: t.attachments.map(adopt) } : t)) }));
}

/**
 * Loads the pictures a saved chat points at (media ids) back into memory. A file that is gone is marked
 * `unavailable`, so the model and the person are told instead of the picture quietly disappearing.
 */
export async function hydrateConversations(
  c: Conversation[],
  read: (mediaId: string) => Promise<{ dataUrl: string } | null>
): Promise<Conversation[]> {
  const need = new Set<string>();
  for (const conv of c) for (const t of conv.turns) for (const a of t.attachments ?? []) {
    if (a.kind === "image" && a.mediaId && !a.dataUrl) need.add(a.mediaId);
  }
  if (!need.size) return c;
  const loaded = new Map<string, string | null>();
  await Promise.all([...need].map(async (id) => {
    try { loaded.set(id, (await read(id))?.dataUrl ?? null); } catch { loaded.set(id, null); }
  }));
  let changed = false;
  const out = c.map((conv) => {
    let convChanged = false;
    const turns = conv.turns.map((t) => {
      if (!t.attachments?.length) return t;
      let turnChanged = false;
      const attachments = t.attachments.map((a) => {
        if (a.kind !== "image" || !a.mediaId || a.dataUrl) return a;
        turnChanged = true;
        const dataUrl = loaded.get(a.mediaId) ?? null;
        return dataUrl ? { ...a, dataUrl, unavailable: false } : { ...a, unavailable: true };
      });
      if (!turnChanged) return t;
      convChanged = true;
      return { ...t, attachments };
    });
    if (!convChanged) return conv;
    changed = true;
    return { ...conv, turns };
  });
  return changed ? out : c;
}

/** Two copies of the chats (this window and the main-process store): keep every chat, and the newer copy of each. */
export function mergeConversations(inMemory: Conversation[], stored: Conversation[]): Conversation[] {
  const byId = new Map<string, Conversation>();
  for (const c of [...stored, ...inMemory]) {
    const prev = byId.get(c.id);
    if (!prev || (c.updated ?? 0) >= (prev.updated ?? 0)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

export function newConversation(projectId: string | null = null): Conversation {
  return { id: crypto.randomUUID(), title: "New chat", updated: Date.now(), projectId, turns: [] };
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 42 ? t.slice(0, 40).trimEnd() + "…" : t || "New chat";
}
