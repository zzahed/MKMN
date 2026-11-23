/**
 * Micro-benchmark of the chat save path, run with `pnpm exec tsx scripts/bench-save-path.ts`
 * (or `node --experimental-strip-types`). It measures, for 0.5 / 2 / 5 MB of synthetic
 * chats, the cost the renderer pays per streamed token BEFORE and AFTER the debounced
 * saver:
 * - before: persistableConversations + JSON.stringify + localStorage.setItem (the
 *   renderer's copy) + a second stringify for the host's copy — on EVERY token;
 * - after: the same work at most once every 1.5 s (measured per flushed save).
 * The absolute ms/token is printed; the "per second" column is the CPU cost of a
 * ~30 token/s stream.
 */
import { performance } from "node:perf_hooks";
import { persistableConversations } from "../src/renderer/store.ts";
import type { Conversation } from "../src/renderer/store.ts";

// a localStorage stand-in with a realistic setItem cost (the copy, not a quota refusal)
const store = new Map<string, string>();
(globalThis as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); }
};

function syntheticChats(totalBytes: number): Conversation[] {
  const convs: Conversation[] = [];
  const turn = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(10);
  let made = 0;
  let id = 0;
  while (made < totalBytes) {
    const turns = [];
    for (let i = 0; i < 20; i++) turns.push({ role: "user" as const, content: turn }, { role: "assistant" as const, content: turn });
    convs.push({ id: `c${id++}`, title: `Chat ${id}`, updated: 1000 + id, turns });
    made += 20 * 2 * turn.length;
  }
  return convs;
}

function bytesOf(convs: Conversation[]): number {
  return JSON.stringify(persistableConversations(convs)).length;
}

/** The OLD path: two stringify passes + one setItem, per token. */
function oldToken(convs: Conversation[]) {
  const clean = persistableConversations(convs);
  localStorage.setItem("opennpu.conversations", JSON.stringify(clean));
  JSON.stringify(clean); // the host's copy (setLocalJson in the Tauri bridge)
}

/** The NEW path: one persistable copy + one stringify + one setItem, per flushed save. */
function newSave(convs: Conversation[]) {
  const clean = persistableConversations(convs);
  localStorage.setItem("opennpu.conversations", JSON.stringify(clean));
}

const TOKENS_PER_SECOND = 30;

for (const mb of [0.5, 2, 5]) {
  const convs = syntheticChats(mb * 1024 * 1024);
  const size = bytesOf(convs);
  // warm up
  oldToken(convs); newSave(convs);

  const N = 30;
  let t0 = performance.now();
  for (let i = 0; i < N; i++) oldToken(convs);
  const oldMs = (performance.now() - t0) / N;

  t0 = performance.now();
  for (let i = 0; i < N; i++) newSave(convs);
  const newMs = (performance.now() - t0) / N;

  console.log(`${mb} MB of chats (persistable form: ${(size / 1024 / 1024).toFixed(2)} MB):`);
  console.log(`  before: ${oldMs.toFixed(2)} ms per streamed token  ->  ${(oldMs * TOKENS_PER_SECOND / 10).toFixed(1)} % of one core at ${TOKENS_PER_SECOND} tok/s`);
  console.log(`  after (per flushed save, <=1 every 1.5 s): ${newMs.toFixed(2)} ms  ->  ${(newMs / 15).toFixed(2)} ms per token over 15 s`);
}
