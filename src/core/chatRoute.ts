// The route stage's thinking decision, taken out of runChatOrchestrator (src/core/chatOrchestrator.ts)
// as it was: how much the chosen model thinks for this request, read from the person's choice,
// the Dynamic team's category and the words, with no model call. The one notice that explains
// a change comes back for the orchestrator to send. Pure: no host, no model.
import type { CatalogEntry, ChatMessage, Effort } from "../shared/types";
import { THINKING_OK, sortRequest, type TaskCategory } from "./dynamic";
import { autoEffort, thinkingSupport } from "./effort";
import { latestArtifacts } from "./review";

export interface EffortChoice {
  effort: Effort | null;
  /** What to tell the person about the level, or null when it stays as they chose. */
  notice: string | null;
}

/** `team` is the Dynamic team's pick for this request, or null for a model chosen by hand. */
export function chooseEffort(effort: Effort | null, entry: CatalogEntry, team: { category: TaskCategory } | null, messages: ChatMessage[]): EffortChoice {
  let notice: string | null = null;
  // a model that can think is told not to, except for reasoning, maths and plans: its thinking is minutes of waiting for a mail or a page
  let effortNow = team && !THINKING_OK.has(team.category) ? ("off" as const) : effort;
  // Auto: the level is read from the kind of request and its words, no model call; a model that cannot think has nothing to settle
  if (effort === "auto" && thinkingSupport(entry) !== "none") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const words = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
    const category = team ? team.category : sortRequest(words, { hasFiles: latestArtifacts(messages).length > 0 }).category;
    const auto = autoEffort(category, words);
    effortNow = auto.level;
    notice = `Thinking: ${auto.level} (${auto.why}).`;
  }
  // the default level (Medium) of a model picked by hand: a request the words already show to be plain (a mail, a translation, a chat) is
  // answered without the minutes of thinking; High, Low and Off are the person's own choice and stay
  if (!team && effort === "medium" && thinkingSupport(entry) === "toggle") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const words = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
    const kind = sortRequest(words, { hasFiles: latestArtifacts(messages).length > 0 });
    if (kind.confidence >= 0.8 && !THINKING_OK.has(kind.category)) {
      effortNow = "off";
      notice = "A plain request: answered without thinking first (choose High to make it think).";
    }
  }
  return { effort: effortNow, notice };
}
