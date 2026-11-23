import { describe, expect, it } from "vitest";
import { Gateway } from "../src/core/harness/gateway";
import { FakeModel, FunctionModel, DELTA, STOP, USAGE, DONE, jsonReply } from "../src/core/harness/testing";
import { sObject, sString, sNumber } from "../src/core/harness/schema";

const SAFE = { temperature: 0, top_p: 1, max_tokens: 50 };
const ask = (fetchFn: typeof fetch, over: Record<string, unknown> = {}) =>
  new Gateway().ask({ endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "hi" }], sampling: SAFE, fetchFn, ...over });

describe("the fake models behind the gateway", () => {
  it("a FakeModel answers a gateway ask, streamed in pieces, with the usage charged", async () => {
    const fake = new FakeModel("Hello there, friend.", {
      chunks: [DELTA("one"), DELTA("two"), STOP, DONE],
    });
    const a = await ask(fake.fetchFn);
    expect(a.text).toBe("Hello there, friend.");
    expect(fake.served).toBe(1);
    const sent = fake.request(0).messages as { role: string; content: string }[];
    expect(sent.some((m) => m.role === "user" && m.content === "hi")).toBe(true);
    expect(sent.some((m) => m.role === "system" && m.content.includes("MKMN AI"))).toBe(true); // the identity rides first
    expect(a.usage.measured).toBe(false); // no usage chunk: the count is an estimate
  });

  it("a measured reply reports real usage, and the last scripted reply repeats", async () => {
    const fake = new FakeModel({
      chunks: [DELTA("first"), USAGE(11, 5), DONE],
    });
    const first = await ask(fake.fetchFn);
    expect(first.usage).toEqual({ prompt: 11, output: 5, measured: true });
    const second = await ask(fake.fetchFn);
    expect(second.text).toBe("first"); // the last reply repeats
    expect(fake.served).toBe(2);
  });

  it("a pushed reply is served after the scripted ones, in order", async () => {
    const fake = new FakeModel("one").push("two").push({ chunks: [DELTA("three"), STOP, DONE] });
    expect((await ask(fake.fetchFn)).text).toBe("one");
    expect((await ask(fake.fetchFn)).text).toBe("two");
    expect((await ask(fake.fetchFn)).text).toBe("three");
    expect((await ask(fake.fetchFn)).text).toBe("three");
  });

  it("a FunctionModel computes its answer from the request body, deterministically", async () => {
    const model = new FunctionModel((body) => {
      const messages = body.messages as { role: string; content: string }[];
      const q = messages.find((m) => m.role === "user")!.content;
      return q === "what is 2+2?" ? "4" : "I do not know.";
    });
    expect(await ask(model.fetchFn, { messages: [{ role: "user", content: "what is 2+2?" }] })).toMatchObject({ text: "4" });
    expect(await ask(model.fetchFn, { messages: [{ role: "user", content: "what is 3+3?" }] })).toMatchObject({ text: "I do not know." });
    expect(model.served).toBe(2);
  });

  it("the health probe is up, so a call with a recover callback can be tested against a hang", async () => {
    // The gateway's watchdog: a reply that streams and then hangs, the server gone,
    // one recovery, the ask again. The FakeModel is the hung server.
    const fake = new FakeModel(
      { chunks: [DELTA("Hel")], hang: true },
      { chunks: [DELTA("Hello!"), STOP, DONE] },
    );
    let up = false;
    const raw = fake.fetchFn;
    fake.fetchFn = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return up ? new Response("{}", { status: 200 }) : Promise.reject(new Error("fetch failed"));
      return raw(url, init);
    }) as typeof fetch;
    const a = await ask(fake.fetchFn, { noProgressSec: 0.05, recover: async () => { up = true; return true; } });
    expect(a.text).toBe("Hello!");
    expect(fake.served).toBe(2);
  });

  it("the typed-answer ladder works against a FakeModel too", async () => {
    const schema = sObject("plan", { title: sString(), count: sNumber({ int: true }) });
    const fake = new FakeModel(jsonReply({ title: "the plan", count: 3 }));
    const out = await new Gateway().askJson({ endpoint: "http://x/v1", model: "m", messages: [{ role: "user", content: "plan?" }], sampling: SAFE, fetchFn: fake.fetchFn, schema });
    expect(out).toEqual({ title: "the plan", count: 3 });
    expect(fake.served).toBe(1); // the first rung answered
  });
});
