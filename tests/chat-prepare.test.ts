// The prepare stage of a chat turn (src/core/chatPrepare.ts): the "/" tool words of the last
// user message, and which tools the turn may use. Pure: settings and messages in, a plan out.
import { describe, expect, it } from "vitest";
import { prepareTurn } from "../src/core/chatPrepare";
import type { ChatMessage, Settings } from "../src/shared/types";

const settings = (over: Partial<Settings> = {}) => ({ toolsOnCommand: false, agentLoop: true, autoCheck: true, ...over }) as Settings;
const ask = (content: ChatMessage["content"]): ChatMessage[] => [
  { role: "user", content: "earlier /check question" },
  { role: "assistant", content: "earlier answer" },
  { role: "user", content },
];

describe("prepareTurn", () => {
  it("with tools on command off, the messages stay as typed and every tool the settings allow is open", () => {
    const messages = ask("/check Say hello.");
    const p = prepareTurn(settings(), messages, { subagents: true });
    expect(p.messages).toBe(messages);
    expect(p.onCommand).toBe(false);
    expect([...p.asked]).toEqual([]);
    expect(p).toMatchObject({ agentsOptIn: true, useLoop: true, useCheck: true, useBuild: true });
  });

  it("with tools on command, the words come off the last user message only, and only the named tools open", () => {
    const p = prepareTurn(settings({ toolsOnCommand: true }), ask("/check /agents Say hello."), { subagents: true });
    expect(p.messages[2].content).toBe("Say hello.");
    expect(p.messages[0].content).toBe("earlier /check question");
    expect(p.onCommand).toBe(true);
    expect([...p.asked].sort()).toEqual(["agents", "check"]);
    expect(p).toMatchObject({ agentsOptIn: true, useLoop: false, useCheck: true, useBuild: false });
  });

  it("a message in parts loses the words from its first text part only", () => {
    const p = prepareTurn(settings({ toolsOnCommand: true }), ask([
      { type: "text", text: "/build Make a page." },
      { type: "text", text: "/check stays" },
    ] as ChatMessage["content"]), { subagents: false });
    expect(p.messages[2].content).toEqual([{ type: "text", text: "Make a page." }, { type: "text", text: "/check stays" }]);
    expect([...p.asked]).toEqual(["build"]);
    expect(p).toMatchObject({ agentsOptIn: false, useBuild: true, useCheck: false });
  });

  it("the settings still decide: a named tool the settings turn off stays off, and sub-agents need the option", () => {
    const p = prepareTurn(settings({ toolsOnCommand: true, agentLoop: false, autoCheck: false }), ask("/improve /check /agents Go."), { subagents: false });
    expect(p).toMatchObject({ agentsOptIn: false, useLoop: false, useCheck: false });
  });

  it("no user message: nothing to take off", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "/check rules" }];
    const p = prepareTurn(settings({ toolsOnCommand: true }), messages, { subagents: false });
    expect(p.messages).toEqual(messages);
    expect([...p.asked]).toEqual([]);
  });
});
