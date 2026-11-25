import { describe, expect, it } from "vitest";
import { artifactsIn } from "../src/core/artifacts";
import { stepwise, Session } from "../src/core/build";
import { Q, yesNoPrompt } from "../src/core/router";
import type { ChatEvent, ChatMessage } from "../src/shared/types";

/**
 * A model already said the message asks for a program that RUNS. From that point the
 * planner is allowed to choose the shape of the build, not to silently turn the request
 * into a chat because its reply did not use the `Mode:`/`File:` lines. Reported on
 * Seen with "hello world in python please" and "fizzbuzz with colours": the planner
 * answered in prose, `parsePlan` found no build words, and the request was answered
 * instead of built. An explicit `Mode: answer` is different: it is a decision, and the
 * person must be told why the request is answered rather than built.
 */

const stats = { ttftSec: 0.1, tokPerSec: 10, tokens: 5, totalSec: 0.5 };
const textOf = (m: ChatMessage) => (typeof m.content === "string" ? m.content : "");

const run = async (g: AsyncGenerator<ChatEvent, any>) => {
  const events: ChatEvent[] = [];
  let r = await g.next();
  while (!r.done) { events.push(r.value); r = await g.next(); }
  return { events, result: r.value };
};

function model(o: {
  program: "yes" | "no" | "none";
  several?: "yes" | "no" | "none";
  planner?: string;
}) {
  const seen: { sid: string; msgs: ChatMessage[] }[] = [];
  const stream: Session = async function* (sid, msgs) {
    if (/:x:ask$/.test(sid)) {
      const user = textOf(msgs[1]);
      let answer = "";
      if (user.includes("several separate files")) {
        answer = o.several === "yes" ? "yes" : o.several === "no" ? "no" : "";
      } else if (user.includes(Q.program)) {
        answer = o.program === "yes" ? "yes" : o.program === "no" ? "no" : "";
      }
      if (answer) yield { id: sid, type: "answer", text: answer };
      yield { id: sid, type: "done", stats };
      return;
    }
    seen.push({ sid, msgs });
    const text = sid.endsWith(":plan") ? (o.planner ?? "") : sid.endsWith(":explain") ? "Done." : "";
    if (text) yield { id: sid, type: "answer", text };
    yield { id: sid, type: "done", stats };
  };
  return { stream, seen };
}

/** The planner could not answer the "one page or several files" question: prose, no File line, no Mode line. */
const PROSE_PLAN = "I would write a single small program that prints the greeting when it starts.";

async function build(o: Parameters<typeof model>[0], request: string) {
  const m = model(o);
  return { m, ...(await run(stepwise({ id: "c", messages: [{ role: "user", content: request }], stream: m.stream, maxChars: 8000 }))) };
}

describe("a model-confirmed build is not lost to a prose plan", () => {
  it("builds one page when the intent is new and the planner wrote no Mode/File line", async () => {
    const { result } = await build({ program: "yes", several: "none", planner: PROSE_PLAN }, "hello world in python please");
    expect(result.handled).toBe(true);
    const files = artifactsIn(result.text ?? "");
    expect(files.map((f) => f.title)).toEqual(["index.html"]);
  });

  it("builds one page for a request the word lists never knew (fizzbuzz with colours)", async () => {
    const { result } = await build({ program: "yes", several: "none", planner: "Sure, that is a small program." }, "fizzbuzz with colours");
    expect(result.handled).toBe(true);
    expect(artifactsIn(result.text ?? "").map((f) => f.title)).toEqual(["index.html"]);
  });

  it("keeps an explicit Mode: answer, and says that the request is answered instead of built", async () => {
    const { events, result } = await build({ program: "yes", several: "none", planner: "Mode: answer" }, "hello world in python please");
    expect(result.handled).toBe(false);
    const notices = events.filter((e): e is Extract<ChatEvent, { type: "notice" }> => e.type === "notice");
    expect(notices.map((n) => n.text).join(" ")).toMatch(/planner|answer/i);
    expect(artifactsIn(result.text ?? "")).toEqual([]);
  });

  it("still answers when no model said the message asks for a program (the words' fallback stays)", async () => {
    const { events, result } = await build({ program: "none", several: "none", planner: "hmm" }, "hello world in python please");
    expect(result.handled).toBe(false);
    // the routing trail may say that no model answered; it must not claim a planner decision
    expect(events.filter((e) => e.type === "notice").map((n) => (n as any).text).join(" ")).not.toMatch(/planner/i);
  });

  it("still uses the word fallback for a game when no model answered at all", async () => {
    const { result } = await build({ program: "none", several: "none", planner: "hmm" }, "make me a snake game");
    expect(result.handled).toBe(true);
    expect(artifactsIn(result.text ?? "").map((f) => f.title)).toEqual(["index.html"]);
  });
});

/**
 * The real runs (identity-who-en) show the router voting
 * yes on the build question for "Who are you?", and the either-yes of `askEither` made
 * "new" the route — the request walked into the planner and the build's steps before the
 * planner answered it in the chat. An identity question is a conversation about the
 * assistant itself. The new closed question `Q.identity` is asked when the build question
 * said yes; a wrong yes here would turn a build into a chat (the costly mistake), so it is
 * the mirror of the either-yes: either NO wins, and only both models saying yes make it
 * an identity question.
 */
describe("an identity question is a conversation, never a build", () => {
  const identityModel = (identityAnswer: string, planner: string): Session => async function* (sid, msgs) {
    if (/:x:ask$/.test(sid)) {
      const user = textOf(msgs[1]);
      const answer = user.includes(Q.identity) ? identityAnswer : user.includes(Q.program) ? "yes" : "";
      if (answer) yield { id: sid, type: "answer", text: answer };
      yield { id: sid, type: "done", stats };
      return;
    }
    const text = sid.endsWith(":plan") ? planner : "Done.";
    if (text) yield { id: sid, type: "answer", text };
    yield { id: sid, type: "done", stats };
  };

  it("the router's wrong yes on the build question for 'Who are you?' is corrected: both models say identity, and nothing is built", async () => {
    const { events, result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "Who are you?" }] as ChatMessage[],
      stream: identityModel("yes", PROSE_PLAN),
      maxChars: 8000,
      askRouter: async (q: string) => (q === Q.program || q === Q.identity ? true : null),
    }));
    expect(result.handled).toBe(false);
    expect(artifactsIn(result.text ?? "")).toEqual([]);
    const notices = events.filter((e): e is Extract<ChatEvent, { type: "notice" }> => e.type === "notice").map((n) => n.text).join(" ");
    expect(notices).toMatch(/Understood as: chat/);
    expect(notices).toMatch(/asking who the assistant is: router yes, chat model yes/);
  });

  it("a build the router misreads as identity still builds: the chat model's no wins", async () => {
    const { result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "a chess game with a clock" }] as ChatMessage[],
      stream: identityModel("no", PROSE_PLAN),
      maxChars: 8000,
      askRouter: async (q: string) => (q === Q.program || q === Q.identity ? true : null),
    }));
    expect(result.handled).toBe(true);
    expect(artifactsIn(result.text ?? "").map((f) => f.title)).toEqual(["index.html"]);
  });
});

/**
 * The router's lone "no" on the
 * identity question short-circuited `askIdentity` and the chat model was never asked —
 * the very model whose wrong yes on the build question had put the request on the build
 * path. On the real runs the small router answered "no" to the identity question on every
 * identity request (eight trails in the 4b tag), so the carve-out could never fire and
 * "Who are you?" was built into a page. The chat model's clear answer now decides: its
 * yes is the identity route, its no keeps the build, no answer keeps the build. The
 * router's answer rides the trail and cannot decide on its own — its lone yes without
 * the chat model still keeps the build (the polarity above, unchanged).
 */
describe("the identity question is settled by both models, not by the router alone", () => {
  const bothModel = (answers: { program?: string; confirm?: string; identity?: string; several?: string }, planner: string): Session => async function* (sid, msgs) {
    if (/:x:ask$/.test(sid)) {
      const user = textOf(msgs[1]);
      const answer = user.includes(Q.identity) ? (answers.identity ?? "")
        : user.includes(Q.programConfirm) ? (answers.confirm ?? "")
        : user.includes(Q.program) ? (answers.program ?? "")
        : user.includes("several separate files") ? (answers.several ?? "")
        : "";
      if (answer) yield { id: sid, type: "answer", text: answer };
      yield { id: sid, type: "done", stats };
      return;
    }
    const text = sid.endsWith(":plan") ? planner : "Done.";
    if (text) yield { id: sid, type: "answer", text };
    yield { id: sid, type: "done", stats };
  };
  const router = (program: boolean | null, identity: boolean | null) => async (q: string) =>
    q === Q.program ? program : q === Q.identity ? identity : null;

  it("the recorded 4b miss: the router says no to the identity question, the chat model says yes — answered in the chat, nothing built", async () => {
    const { events, result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "Who are you?" }] as ChatMessage[],
      stream: bothModel({ program: "yes", confirm: "yes", identity: "yes" }, PROSE_PLAN),
      maxChars: 8000,
      askRouter: router(false, false),
    }));
    expect(result.handled).toBe(false);
    expect(artifactsIn(result.text ?? "")).toEqual([]);
    const notices = events.filter((e): e is Extract<ChatEvent, { type: "notice" }> => e.type === "notice").map((n) => n.text).join(" ");
    expect(notices).toMatch(/Understood as: chat/);
    expect(notices).toMatch(/asking who the assistant is: router no, chat model yes/);
  });

  it("the warmup shape: the router does not answer and the chat model says yes — answered in the chat", async () => {
    const { result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "Who are you?" }] as ChatMessage[],
      stream: bothModel({ program: "yes", identity: "yes" }, PROSE_PLAN),
      maxChars: 8000,
      askRouter: router(null, null),
    }));
    expect(result.handled).toBe(false);
    expect(artifactsIn(result.text ?? "")).toEqual([]);
  });

  it("a genuine build whose votes split (router no on both, chat model yes, its identity answer no) is answered in the chat with the build offered — the rule (the click builds, pinned by the buildWanted tests)", async () => {
    const { events, result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "a chess game with a clock" }] as ChatMessage[],
      stream: bothModel({ program: "yes", confirm: "yes", identity: "no", several: "no" }, PROSE_PLAN),
      maxChars: 8000,
      askRouter: router(false, false),
    }));
    expect(result.handled).toBe(false);
    expect(events.some((e) => e.type === "offer")).toBe(true);
    expect(artifactsIn(result.text ?? "")).toEqual([]);
  });

  it("neither model answers the identity question on a split vote: answered in the chat with the build offered (no silent build)", async () => {
    const { events, result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "a chess game with a clock" }] as ChatMessage[],
      stream: bothModel({ program: "yes", confirm: "yes", identity: "", several: "no" }, PROSE_PLAN),
      maxChars: 8000,
      askRouter: router(null, null),
    }));
    expect(result.handled).toBe(false);
    expect(events.some((e) => e.type === "offer")).toBe(true);
  });
});

/**
 * The 4b real runs never built the snake game — three attempts, and each
 * notice reads "Understood as: chat (router no, chat model no)". The chat model's vote is
 * already a cooled worker vote (codeSampling, temperature at most 0.25), so its three
 * identical noes are a stable answer, not a coin flip; the router's no is greedy and
 * deterministic. The one lever the architecture allows is the question's own solved
 * cases: Q.program had a French game but no game request in English or Arabic, and the
 * real run's request is an English one. The cases below are other games than the real
 * run's request, so the real runs still measure the router itself.
 */
describe("the build question's solved cases", () => {
  it("name a game in English and Arabic, and a game word outside a build stays no", () => {
    const sys = yesNoPrompt("a snake game in html", Q.program).system;
    expect(sys).toMatch(/chess game[^;]*-> yes/);
    expect(sys).toMatch(/لعبة إكس-أو[^;]*-> yes/);
    expect(sys).toMatch(/yesterday's game\? -> no/);
  });
});

/**
 * When the build votes SPLIT — the router says no
 * or does not answer, and the chat model says yes — the request is never built silently.
 * It is answered in the chat, and ONE action is offered under the answer, "Build it
 * instead", which sends the same request through the build path. The confirming question
 * added in an earlier build is gone for this case: the real 4b confgate measured it adding nothing
 * (both of its false builds went through the model's own confirmed yes, and the answers
 * it saved from a build are answered in the chat either way — now with the work one
 * click away instead of lost). A router yes, or both votes yes, still builds directly.
 * A configuration with no router at all keeps the confirming question: the
 * protection for the lone chat-model yes that built 4 of 24 knowledge answers in the
 * earlier records (the router not being there at all is not a split of two votes).
 */
describe("a split build vote is answered in the chat, with the build offered as one action", () => {
  const gateModel = (answers: { program?: string; confirm?: string; identity?: string; several?: string }, planner: string): { stream: Session; asked: string[] } => {
    const asked: string[] = [];
    const stream: Session = async function* (sid, msgs) {
      if (/:x:ask$/.test(sid)) {
        const user = textOf(msgs[1]);
        asked.push(user);
        const answer = user.includes(Q.identity) ? (answers.identity ?? "")
          : user.includes("several separate files") ? (answers.several ?? "")
          : user.includes(Q.program) ? (answers.program ?? "")
          : (answers.confirm ?? "");
        if (answer) yield { id: sid, type: "answer", text: answer };
        yield { id: sid, type: "done", stats };
        return;
      }
      const text = sid.endsWith(":plan") ? planner : "Done.";
      if (text) yield { id: sid, type: "answer", text };
      yield { id: sid, type: "done", stats };
    };
    return { stream, asked };
  };
  const router = (program: boolean | null) => async (_q: string) => program;

  it("a knowledge question stays in chat when the models disagree, without a build offer", async () => {
    const { stream, asked } = gateModel({ program: "yes", confirm: "yes", identity: "no" }, PROSE_PLAN);
    const { events, result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "where is the spare key?" }] as ChatMessage[],
      stream,
      maxChars: 8000,
      askRouter: router(false),
    }));
    expect(result.handled).toBe(false);
    expect(artifactsIn(result.text ?? "")).toEqual([]);
    // the confirming question is gone for the split case: the model was asked the build
    // question and the identity question, and nothing more
    expect(asked.filter((q) => q.includes("make a program, page or file"))).toEqual([]);
    const offers = events.filter((e): e is Extract<ChatEvent, { type: "offer" }> => e.type === "offer");
    expect(offers).toHaveLength(0);
    const notices = events.filter((e): e is Extract<ChatEvent, { type: "notice" }> => e.type === "notice").map((n) => n.text).join(" ");
    expect(notices).toMatch(/Understood as: chat/);
    expect(notices).toMatch(/router no, chat model yes/);
  });

  it.each([false, null])("the acceptance reply gets no offer when the router answers %s", async (vote) => {
    const { stream } = gateModel({ program: "yes", identity: "no" }, PROSE_PLAN);
    const { events, result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "Acceptance check. Reply with only the number 7." }],
      stream, maxChars: 8000, askRouter: router(vote),
    }));
    expect(result.handled).toBe(false);
    expect(events.some((e) => e.type === "offer")).toBe(false);
  });

  it.each(["Could you create a timer app?", "أريد لعبة إكس-أو", "أريد تطبيق مؤقت"])("keeps an offer for an ambiguous build request: %s", async (request) => {
    const { stream } = gateModel({ program: "yes", identity: "no" }, PROSE_PLAN);
    const { events, result } = await run(stepwise({
      id: "c", messages: [{ role: "user", content: request }],
      stream, maxChars: 8000, askRouter: router(false),
    }));
    expect(result.handled).toBe(false);
    expect(events.filter((e) => e.type === "offer")).toEqual([{ id: "c", type: "offer", offer: { action: "build", request } }]);
  });

  it.each([
    ["Make the background blue", true],
    ["Could you make the background blue?", true],
    ["Can you please make it blue?", true],
    ["What is the background colour?", false],
    ["Acceptance check. Reply with only the number 7.", false],
  ])("filters offers in existing-file context: %s", async (request, offered) => {
    const { stream } = gateModel({ program: "yes", identity: "no" }, PROSE_PLAN);
    const { events } = await run(stepwise({
      id: "c",
      messages: [
        { role: "assistant", content: '<artifact type="html" title="index.html">\n<html><body>Hello</body></html>\n</artifact>' },
        { role: "user", content: request },
      ],
      stream, maxChars: 8000, askRouter: router(false),
    }));
    expect(events.some((e) => e.type === "offer")).toBe(offered);
  });

  it("(c) a router yes builds directly ('make a snake game'), with no action offered", async () => {
    const { stream } = gateModel({ program: "yes", identity: "no", several: "no" }, PROSE_PLAN);
    const { events, result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "make a snake game" }] as ChatMessage[],
      stream,
      maxChars: 8000,
      askRouter: router(true),
    }));
    expect(result.handled).toBe(true);
    expect(artifactsIn(result.text ?? "").map((f) => f.title)).toEqual(["index.html"]);
    expect(events.some((e) => e.type === "offer")).toBe(false);
  });

  it("(d) the long build request the router wrongly said no to still reaches a build in one click (buildWanted: the click is the yes, the votes are not asked)", async () => {
    const long = "I want a 2D game like the first Super Mario Bros. You play a little character who runs and jumps from left to right through a level.";
    const { stream } = gateModel({ program: "no", confirm: "no", identity: "no", several: "no" }, PROSE_PLAN);
    const { result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: long }] as ChatMessage[],
      stream,
      maxChars: 8000,
      askRouter: router(false),
      buildWanted: true,
    }));
    expect(result.handled).toBe(true);
    expect(artifactsIn(result.text ?? "").length).toBeGreaterThan(0);
  });

  it("no router at all is not a split: the chat model's lone yes is still confirmed before it builds (the protection stays)", async () => {
    const { stream, asked } = gateModel({ program: "yes", confirm: "no" }, PROSE_PLAN);
    const { result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "where is the spare key?" }] as ChatMessage[],
      stream,
      maxChars: 8000,
    }));
    expect(result.handled).toBe(false);
    expect(artifactsIn(result.text ?? "")).toEqual([]);
    expect(asked.filter((q) => q.includes("make a program, page or file"))).toHaveLength(1); // the confirm was asked
  });

  it("no router at all, and the confirm says yes: it builds", async () => {
    const { stream } = gateModel({ program: "yes", confirm: "yes", several: "no" }, PROSE_PLAN);
    const { result } = await run(stepwise({
      id: "c",
      messages: [{ role: "user", content: "make a snake game" }] as ChatMessage[],
      stream,
      maxChars: 8000,
    }));
    expect(result.handled).toBe(true);
    expect(artifactsIn(result.text ?? "").map((f) => f.title)).toEqual(["index.html"]);
  });

  it("the confirming question exists and carries its own solved cases, of other subjects than the lab's and the evals'", () => {
    const sys = yesNoPrompt("where is the spare key?", Q.programConfirm).system;
    expect(sys).toMatch(/pomodoro timer page -> yes/);
    expect(sys).toMatch(/مuseum open\? -> no|what time does the museum open\? -> no/);
  });
});
