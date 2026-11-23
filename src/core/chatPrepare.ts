// The prepare stage of a chat turn, taken out of runChatOrchestrator (src/core/chatOrchestrator.ts)
// as it was: with "tools on command" on, the "/" words at the start of the last user message
// say which tools this message may use and come off the message; the settings and the
// options decide the rest. Pure: no host, no model.
import { readBool } from "../shared/settingsSchema";
import type { ChatMessage, ChatOptions, Settings } from "../shared/types";
import { takeToolCommands, type ToolName } from "./toolCommands";

export interface PreparedTurn {
  /** The messages the turn works on: the same array when nothing was taken off. */
  messages: ChatMessage[];
  /** Tools on command is on: a tool runs only when the message named it. */
  onCommand: boolean;
  /** The tools the message named. */
  asked: Set<ToolName>;
  /** Sub-agents are allowed here; a closed question later decides whether this request needs them. */
  agentsOptIn: boolean;
  useLoop: boolean;
  useCheck: boolean;
  /** The steps that plan, write, test and fix files (decks, templates, pages, programs). */
  useBuild: boolean;
}

export function prepareTurn(settings: Settings, messages: ChatMessage[], opts: Pick<ChatOptions, "subagents">): PreparedTurn {
  // tools on command: the "/" words at the start of the message say which tools this message may use, and are not part of the request
  const onCommand = readBool(settings, "toolsOnCommand");
  const asked = new Set<ToolName>();
  if (onCommand) {
    const at = messages.map((m) => m.role).lastIndexOf("user");
    const last = messages[at];
    if (typeof last?.content === "string") {
      const r = takeToolCommands(last.content);
      r.used.forEach((t) => asked.add(t));
      messages = messages.map((m, i) => (i === at ? { ...m, content: r.text } : m));
    } else if (last) {
      const parts = last.content.map((p) => {
        if (p.type !== "text" || asked.size) return p;
        const r = takeToolCommands(p.text);
        r.used.forEach((t) => asked.add(t));
        return { ...p, text: r.text };
      });
      messages = messages.map((m, i) => (i === at ? { ...m, content: parts } : m));
    }
  }
  const may = (t: ToolName) => !onCommand || asked.has(t);
  // The option alone does not put the delegation rules in the request: `agentsOptIn` only says the
  // person allows them here, and the orchestrator's closed question decides whether THIS request needs them.
  const agentsOptIn = !!opts.subagents && may("agents");
  const useLoop = settings.agentLoop && may("improve");
  const useCheck = settings.autoCheck && may("check");
  const useBuild = may("build"); // the steps that plan, write, test and fix files (decks, templates, pages, programs)
  return { messages, onCommand, asked, agentsOptIn, useLoop, useCheck, useBuild };
}
