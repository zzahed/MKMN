import { persistableConversations, type Conversation, type SaveConversationsResult } from "./store";

/**
 * Debounced saver for the chats. Every streamed token used to stringify and write the
 * WHOLE chat list (twice: this storage, then the host's copy), which cost seconds of CPU
 * per minute of answering on large histories. The saver keeps one pending copy and:
 * - while turns are streaming, writes at most once every SAVE_MIN_INTERVAL_MS;
 * - writes at once when a turn starts or ends, on any change made while nothing is
 *   streaming (a conversation created, deleted, renamed, pinned...), and whenever
 *   `flushNow` is called (window hidden, page hidden or closed, host shutdown).
 *
 * Nothing is lost compared to the eager saves except, at worst, the last
 * SAVE_MIN_INTERVAL_MS of a streaming answer after a hard crash: a turn end always
 * flushes, and so does every orderly exit path.
 * The persistable form is computed once per write and handed to both writers.
 * Clock and timers are injectable so tests can run a fake clock.
 */
export const SAVE_MIN_INTERVAL_MS = 1500;

export interface ConversationSaverDeps {
  now?: () => number;
  /** The write the app reads back at start (this profile's storage). */
  write: (clean: Conversation[]) => SaveConversationsResult;
  /** The host's copy, from the same persistable list (a file in the legacy main-process build; nothing in the Tauri build). */
  writeHost?: (clean: Conversation[]) => void;
  /** The result of each write (the storage-full warnings). */
  onResult: (r: SaveConversationsResult) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface ConversationSaver {
  /**
   * A change to the chats happened. `pendingTurns` is how many turns are streaming:
   * a count that stays the same while > 0 is streamed tokens (throttled), any change
   * in the count — or a change while nothing streams — writes at once.
   */
  touch(convs: Conversation[], pendingTurns: number): void;
  /** Write at once (turn end, window hidden or closed, host shutdown). */
  flushNow(convs?: Conversation[]): void;
  /** Give up the pending timer (the app is unmounting). */
  dispose(): void;
}

export function createConversationSaver(deps: ConversationSaverDeps): ConversationSaver {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));

  let latest: Conversation[] | null = null;
  let lastWrite = -Infinity;
  let timer: unknown = null;
  let lastPendingTurns = 0;

  const write = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!latest) return;
    // ONE persistable copy per save, shared by both writers.
    const clean = persistableConversations(latest);
    const r = deps.write(clean);
    deps.onResult(r);
    deps.writeHost?.(clean);
    lastWrite = now();
    latest = null;
  };

  return {
    touch(convs, pendingTurns) {
      latest = convs;
      const was = lastPendingTurns;
      lastPendingTurns = pendingTurns;
      if (pendingTurns > 0 && pendingTurns === was) {
        // Streamed tokens: at most one write per SAVE_MIN_INTERVAL_MS.
        if (timer !== null) return;
        const wait = SAVE_MIN_INTERVAL_MS - (now() - lastWrite);
        if (wait <= 0) write();
        else timer = setTimer(write, wait);
      } else {
        // A turn started or ended (done or error), or a change while nothing streams
        // (created, deleted, renamed, pinned, the title, the memo...): at once.
        write();
      }
    },
    flushNow(convs) {
      if (convs) latest = convs;
      write();
    },
    dispose() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      latest = null;
    }
  };
}
