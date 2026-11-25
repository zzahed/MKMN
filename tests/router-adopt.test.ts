import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ServerManager } from "../src/core/server";
import { servesRouterModel } from "../src/core/router";

/**
 * The router adopted ANY answer on its fixed port (so a second MKMN uses the
 * first one's router instead of fighting for the port). An unrelated program listening
 * there would have been adopted and sent the person's questions. Adoption now needs
 * the endpoint's models list to be a GenieX list holding the router's model; a second
 * MKMN's router still qualifies, a stranger never does.
 */

// the shape the real GenieX server on this PC answered on /v1/models, trimmed
const REAL = {
  object: "list",
  data: [
    { id: "bartowski/Qwen_Qwen3-8B-GGUF:Q4_0", created: 0, object: "model", owned_by: "bartowski", shutdown_date: "0001-01-01T00:00:00Z" },
    { id: "qualcomm/Qwen3-4B:W4A16", created: 0, object: "model", owned_by: "qualcomm", shutdown_date: "0001-01-01T00:00:00Z" },
    { id: "unsloth/Qwen3-0.6B-GGUF:Q4_0", created: 0, object: "model", owned_by: "unsloth", shutdown_date: "0001-01-01T00:00:00Z" },
  ],
};

describe("servesRouterModel", () => {
  it("accepts the real GenieX list that holds the router model", () => {
    expect(servesRouterModel(REAL)).toBe(true);
  });
  it("accepts the router model under its other repo", () => {
    expect(servesRouterModel({ data: [{ id: "bartowski/Qwen_Qwen3-0.6B-GGUF:Q4_0" }] })).toBe(true);
  });
  it("follows the router models installed here, matched as repo:quant", () => {
    // any small installed model can be the router: the list must hold one of THEM
    expect(servesRouterModel(REAL, ["qualcomm/Qwen3-4B:W4A16"])).toBe(true);
    expect(servesRouterModel(REAL, ["qualcomm/Qwen3-4B:Q8_0"])).toBe(false);
    expect(servesRouterModel({ data: [{ id: "Unsloth/Qwen3-0.6B-GGUF:Q4_0" }] }, ["unsloth/qwen3-0.6b-gguf:q4_0"])).toBe(true);
  });
  it("refuses a list without the router model, and anything that is not a list", () => {
    expect(servesRouterModel({ data: [{ id: "qualcomm/Qwen3-4B:W4A16" }] })).toBe(false);
    expect(servesRouterModel({ models: ["unsloth/Qwen3-0.6B-GGUF"] })).toBe(false);
    expect(servesRouterModel("ok")).toBe(false);
    expect(servesRouterModel(null)).toBe(false);
  });
});

const fakeChild = (dies = false): any => {
  const c: any = new EventEmitter();
  c.pid = undefined;
  c.exitCode = null;
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kill = () => { c.exitCode = 0; queueMicrotask(() => c.emit("close", 0)); return true; };
  if (dies) queueMicrotask(() => { c.exitCode = 1; c.emit("close", 1); });
  return c;
};
const answer = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as any;

describe("the router adopts only a server that serves its model", () => {
  it("a second MKMN's router is adopted, nothing is spawned", async () => {
    const spawned: any[] = [];
    const m = new ServerManager({
      exe: "not-a-real-runtime", host: "127.0.0.1:18191", adoptExisting: true, adoptIf: servesRouterModel,
      spawnFn: (() => { spawned.push(1); return fakeChild(); }) as any,
      fetchFn: answer(REAL), pollMs: 1, readyTimeoutMs: 100,
    });
    try {
      await m.start(2048);
      expect(m.status().adopted).toBe(true);
      expect(spawned).toEqual([]);
    } finally { await m.stop(); }
  });

  it("another program on the port is not adopted, and the failure names it", async () => {
    const spawned: any[] = [];
    const m = new ServerManager({
      exe: "not-a-real-runtime", host: "127.0.0.1:18192", adoptExisting: true, adoptIf: servesRouterModel,
      // our own child cannot bind the port the stranger holds: it dies at once
      spawnFn: (() => { spawned.push(1); return fakeChild(true); }) as any,
      fetchFn: answer({ data: [{ id: "someone-else/model" }] }), pollMs: 1, readyTimeoutMs: 5000,
    });
    m.on("error", () => undefined);
    try {
      await expect(m.start(2048)).rejects.toThrow();
      expect(m.status().adopted ?? false).toBe(false);
      expect(spawned.length).toBe(1);
      expect(m.status().lastError?.title).toBe("Another program is blocking MKMN's AI (port 18192)");
    } finally { await m.stop(); }
  });

  it("an adopted router that stops serving the router model is dropped on the next start", async () => {
    let body: unknown = REAL;
    const m = new ServerManager({
      exe: "not-a-real-runtime", host: "127.0.0.1:18193", adoptExisting: true, adoptIf: servesRouterModel,
      spawnFn: (() => fakeChild(true)) as any,
      fetchFn: (async () => ({ ok: true, json: async () => body })) as any, pollMs: 1, readyTimeoutMs: 5000,
    });
    m.on("error", () => undefined);
    try {
      await m.start(2048);
      expect(m.status().adopted).toBe(true);
      body = { data: [] };
      await expect(m.start(2048)).rejects.toThrow();
      expect(m.status().adopted ?? false).toBe(false);
    } finally { await m.stop(); }
  });
});
