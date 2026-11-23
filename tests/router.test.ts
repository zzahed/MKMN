import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { CONFIRM, ROOT, ROUTER_BELOW, ROUTER_BREAKER_MS, ROUTER_MODEL, FileKindMemo, RouterBreaker, RouterWarmGate, SortMemory, WarmUp, TREE, parseYesNo, routerWanted, sortByQuestions, withRouter, yesNoPrompt } from "../src/core/router";
import { CATEGORY_IDS, type TaskCategory } from "../src/core/dynamic";

const KINDS = new Set<string>(CATEGORY_IDS);

/** Every kind a node can lead to, to build a model that always answers right. */
function reach(id: string, seen = new Set<string>()): Set<string> {
  if (KINDS.has(id)) return new Set([id]);
  if (seen.has(id)) return new Set();
  seen.add(id);
  return new Set([...reach(TREE[id].yes, seen), ...reach(TREE[id].no, seen)]);
}
/** A perfect model: it says yes to a question when the real kind is somewhere under its yes. */
const oracle = (truth: TaskCategory, log: string[] = []) => async (_ask: string, id: string) => { log.push(id); return reach(TREE[id].yes).has(truth); };

const REACHABLE = [...new Set(Object.values(TREE).flatMap((n) => [...reach(n.yes), ...reach(n.no)]))].sort();

describe("the router's questions", () => {
  it("lead to every kind a request can have, except what the shape of a request says (an image, a long text, a greeting)", () => {
    expect(REACHABLE).toEqual(CATEGORY_IDS.filter((c) => c !== "vision" && c !== "long_context" && c !== "fast").sort());
  });
  it("are a tree: each answer leads to a kind or to another question, never round in a circle", () => {
    for (const [id, n] of Object.entries(TREE)) {
      for (const next of [n.yes, n.no]) expect(KINDS.has(next) || next in TREE, `${id} -> ${next}`).toBe(true);
      expect(n.ask.endsWith("?"), id).toBe(true);
      expect(n.ask.length, id).toBeLessThan(150);
    }
    const depth = (id: string, d = 0): number => (KINDS.has(id) ? d : Math.max(depth(TREE[id].yes, d + 1), depth(TREE[id].no, d + 1)));
    expect(depth(ROOT)).toBeLessThanOrEqual(8); // the longest path (a plain conversation) is 7 questions
  });
  it("find the right kind for each of them when the model answers right", async () => {
    for (const k of REACHABLE) {
      const log: string[] = [];
      const r = await sortByQuestions(oracle(k as TaskCategory, log));
      expect(r.kind, k).toBe(k);
      expect(r.asked.map((a) => a.id)).toEqual(log);
    }
  });
  it("go straight to the kind the words lean towards: one question for most, two for code, and fall back to all of them when it was wrong", async () => {
    const asked = async (truth: TaskCategory, lean: TaskCategory) => { const log: string[] = []; const r = await sortByQuestions(oracle(truth, log), lean); return { kind: r.kind, log }; };
    expect(await asked("math", "math")).toEqual({ kind: "math", log: ["q_math"] });
    expect(await asked("web_code", "web_code")).toEqual({ kind: "web_code", log: ["q_code", "q_web"] });
    expect(await asked("code_repair", "code_repair")).toEqual({ kind: "code_repair", log: ["q_code", "q_error"] });
    // the words said a translation, it is a page to build: the question about translation is no, the others find it
    const wrong = await asked("web_code", "translate_other");
    expect(wrong.kind).toBe("web_code");
    expect(wrong.log[0]).toBe("q_translate");
    expect(wrong.log.filter((id) => id === "q_translate")).toHaveLength(1); // never asked twice
    // the words said code and it is python: web is no
    expect(await asked("python_code", "web_code")).toEqual({ kind: "python_code", log: ["q_code", "q_web", "q_error", "q_read"] });
    // every kind the words may lean towards has a question that leads towards it
    for (const [kind, q] of Object.entries(CONFIRM)) expect(q! in TREE, kind).toBe(true);
  });
  it("give up on a reply that is neither yes nor no, and on too many questions, so the words' guess stands", async () => {
    expect((await sortByQuestions(async () => null)).kind).toBeNull();
    let n = 0;
    expect((await sortByQuestions(async () => (n++ < 2 ? false : null))).kind).toBeNull();
    const capped = await sortByQuestions(async () => false, undefined, 3);
    expect(capped.kind).toBeNull();
    expect(capped.asked).toHaveLength(3);
    const chat = await sortByQuestions(async () => false);
    expect(chat.kind).toBe("chat"); // all no: a plain conversation
    expect(chat.asked).toHaveLength(7);
  });
  it("are asked with the request first and one word to answer", () => {
    const p = yesNoPrompt("explain compound interest to me with an interactive diagram", TREE.q_web.ask);
    expect(p.user.startsWith('Request: """explain compound')).toBe(true);
    expect(p.user).toContain(`Question: ${TREE.q_web.ask}`);
    expect(p.user.endsWith("Answer (yes or no):")).toBe(true);
    expect(p.system).toMatch(/one word: yes or no/);
    expect(p.system).toMatch(/not by the language/);
    expect((p.system.length + p.user.length) / 3.5).toBeLessThan(250); // tokens: a short prompt, the request is read once
  });
  it("read the word it answers: yes or no, whatever it wraps around it", () => {
    expect(parseYesNo("yes")).toBe(true);
    expect(parseYesNo(" Yes.\n")).toBe(true);
    expect(parseYesNo("No, it is not")).toBe(false);
    expect(parseYesNo("<think>\nmaybe yes\n</think>\nno")).toBe(false);
    expect(parseYesNo("maybe")).toBeNull();
    expect(parseYesNo("")).toBeNull();
  });
});

describe("the router in the Dynamic model", () => {
  it("is asked only when the rules hesitate, never for an image or a long text", () => {
    expect(routerWanted({ category: "chat", confidence: 0.4, reason: "x" })).toBe(true);
    expect(routerWanted({ category: "web_code", confidence: ROUTER_BELOW, reason: "x" })).toBe(false);
    expect(routerWanted({ category: "vision", confidence: 0.3, reason: "x" })).toBe(false);
    expect(routerWanted({ category: "long_context", confidence: 0.5, reason: "x" })).toBe(false);
  });
  it("puts the router's word over the rules' guess, and keeps the guess when it has none", () => {
    const rules = { category: "translate_fr" as TaskCategory, confidence: 0.45, reason: "written in French" };
    expect(withRouter(rules, "web_code")).toMatchObject({ category: "web_code", reason: "the router model sorted it" });
    expect(withRouter(rules, null)).toBe(rules);
  });
  it("is a small model that is installed like the others, from two providers", () => {
    expect(ROUTER_MODEL.quant).toBe("Q4_0");
    expect(ROUTER_MODEL.sizeGB).toBeLessThan(0.6);
    expect(ROUTER_MODEL.altRepos?.length).toBeGreaterThan(0);
  });
  it("remembers what it sorted, forgetting the oldest", () => {
    const m = new SortMemory(2);
    m.set("A", "math"); m.set("b", "chat"); m.set("C", "fast");
    expect(m.get("a")).toBeUndefined();
    expect(m.get(" B ")).toBe("chat");
    expect(m.get("c")).toBe("fast");
  });
});

describe("the router comes with the packs", () => {
  it("every pack carries the router model, outside the models that answer", async () => {
    const { default: data } = await import("../src/core/dynamic-data.json");
    const { packParts } = await import("../src/core/dynamic");
    for (const pack of Object.values(data.packs) as any[]) {
      expect(pack.router?.repo).toBe(ROUTER_MODEL.repo);
      expect(pack.router?.ref).toBe(ROUTER_MODEL.ref);
      expect(pack.models.some((m: any) => m.ref === pack.router.ref)).toBe(false);
      expect(packParts(pack)).toContain(pack.router);
    }
  });
});

/**
 * From on-device test runs: a WEDGED router (one that accepts the connection and
 * never answers) re-paid its whole short timeout for EVERY closed question of a turn —
 * the sort shares one signal, but each yes/no of the build gate, the file kind, identity,
 * recall went through its own fresh timeout, ten times 2 s and more on one request. The
 * rule: a router that times out costs at most its short timeout ONCE per request. The
 * breaker holds that: the first failure opens it, the questions after it are answered
 * null at once (the words' guess stands, the established degradation), and a successful
 * answer closes it again.
 */
describe("the router breaker: one timeout per request", () => {
  it("is shut at first, opens on a trip, and closes on the router's next success", () => {
    const b = new RouterBreaker();
    expect(b.isOpen()).toBe(false);
    b.trip();
    expect(b.isOpen()).toBe(true);
    b.close();
    expect(b.isOpen()).toBe(false);
  });
  it("stays open for its whole window, then lets the next request meet the router fresh", () => {
    const t0 = 1_000_000;
    const b = new RouterBreaker();
    b.trip(t0);
    expect(b.isOpen(t0 + 1)).toBe(true);
    expect(b.isOpen(t0 + ROUTER_BREAKER_MS - 1)).toBe(true);
    expect(b.isOpen(t0 + ROUTER_BREAKER_MS)).toBe(false);
  });
  it("a second trip while open does not shorten the window", () => {
    const t0 = 1_000_000;
    const b = new RouterBreaker();
    b.trip(t0);
    b.trip(t0 + 100); // a later failure in the same window must not pull the edge closer
    expect(b.isOpen(t0 + 100 + ROUTER_BREAKER_MS - 1)).toBe(true);
    expect(b.isOpen(t0 + 100 + ROUTER_BREAKER_MS)).toBe(false);
  });
  it("the window it opens is the shipped one, long enough for the closed questions of one request", () => {
    expect(ROUTER_BREAKER_MS).toBeGreaterThanOrEqual(30_000);
    expect(ROUTER_BREAKER_MS).toBeLessThanOrEqual(60_000);
  });
  it("is an upper bound only: a router recovered mid-window is met again at once (close ends an open window)", () => {
    const t0 = 1_000_000;
    const b = new RouterBreaker();
    b.trip(t0);
    expect(b.isOpen(t0 + 5_000)).toBe(true); // the next request inside the window still skips, the words' guess stands
    b.close(); // the background warm's success, seconds later
    expect(b.isOpen(t0 + 6_000)).toBe(false); // long before the window expires
  });
});

/**
 * Root cause of the silent router (on-device test runs + live probes): a fresh
 * `geniex serve --compute cpu` answers /v1/models and /health about 0.6 s after it is
 * spawned — with NO model loaded — and the model's first load takes about 3.5 s. The
 * router's server is "ready" long before it can answer, so the first one or two asks of
 * every fresh server (spawned, re-spawned after a crash, or adopted cold from another
 * instance) burned their whole 2 s timeout, and the 30 s breaker then locked the rest of
 * the request out for a timeout that was never the router's fault. The gate refuses the
 * asks until the model has answered ONCE on the current server (the warm), and resets
 * when the server changes under it.
 */
describe("the router warm gate: no ask reaches a server whose model has not answered once", () => {
  it("refuses until the warm answers, then lets every ask through", () => {
    const g = new RouterWarmGate();
    expect(g.open).toBe(false);
    g.markWarmed();
    expect(g.open).toBe(true);
  });
  it("resets when the server changes (a respawn or a new adoption loads the model again)", () => {
    const g = new RouterWarmGate();
    g.markWarmed();
    g.reset();
    expect(g.open).toBe(false);
    g.markWarmed();
    expect(g.open).toBe(true);
  });
});

describe("the router warm-up: one at a time, and a forced one is never lost", () => {
  /** A warm-up that waits until the test lets it end, as one against a loading server does. */
  const gate = () => { let end!: (ok: boolean) => void; const done = new Promise<boolean>((r) => { end = r; }); return { end, done }; };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("runs one warm-up and skips a plain request made while it runs", async () => {
    const w = new WarmUp();
    const g = gate();
    let runs = 0;
    const task = async () => { runs++; await g.done; };
    w.start(task);
    w.start(task);
    expect(w.busy).toBe(true);
    g.end(true);
    await settle();
    expect(runs).toBe(1);
    expect(w.busy).toBe(false);
  });

  it("runs a forced request made during a warm-up once more when it ends (the router moved to another server meanwhile)", async () => {
    const w = new WarmUp();
    const first = gate();
    const servers: string[] = [];
    let server = "npu";
    w.start(async () => { servers.push(server); await first.done; });
    server = "gpu"; // routerMissed: the server is stopped and restarted elsewhere while the first warm-up still runs
    w.start(async () => { servers.push(server); }, true);
    w.start(async () => { servers.push(server); }, true); // a second forced request while one is queued: still one re-run
    first.end(false);
    await settle();
    await settle();
    expect(servers).toEqual(["npu", "gpu"]);
    expect(w.busy).toBe(false);
  });

  it("re-runs after a warm-up that failed, and a failure never escapes", async () => {
    const w = new WarmUp();
    let runs = 0;
    w.start(async () => { runs++; await settle(); throw new Error("the server went away"); });
    w.start(async () => { runs++; }, true);
    await settle();
    await settle();
    await settle();
    expect(runs).toBe(2);
    expect(w.busy).toBe(false);
  });
});

/**
 * Exposed by the warm gate's live probe: the file-kind question remembers its
 * answer per message text — and it remembered a NON-answer (the router was cold and
 * gated) as if it were one, so every later ask of the same text got the poisoned
 * "no answer" without ever reaching the now-warm router. A question without an answer
 * is a question not yet asked; only a real outcome is remembered.
 */
describe("the file-kind memory: only real outcomes are remembered", () => {
  it("a non-answer (undefined) is not remembered: a later ask tries again", () => {
    const m = new FileKindMemo();
    m.set("make me an excel sheet", undefined);
    expect(m.get("make me an excel sheet")).toBeUndefined();
    m.set("make me an excel sheet", "xlsx");
    expect(m.get("make me an excel sheet")).toBe("xlsx");
  });
  it("a real outcome is remembered for the same text only (one slot, the newest ask), and a veto too", () => {
    const m = new FileKindMemo();
    m.set("a", null); // the router said no file is to be produced
    expect(m.get("a")).toBeNull();
    expect(m.get("b")).toBeUndefined();
    m.set("b", "docx"); // a new ask replaces the slot, the way one message follows the next
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBe("docx");
    m.set("b", undefined); // a later non-answer must not poison a remembered outcome
    expect(m.get("b")).toBe("docx");
  });
});

describe("the breaker is wired in the sidecar's router", () => {
  const main = fs.readFileSync(new URL("../src/sidecar/main.ts", import.meta.url), "utf8");
  it("asks nothing while it is open, and the questions after a failure cost nothing", () => {
    // the open check stands before every path that could reach the server
    expect(main).toMatch(/routerBreaker\.isOpen\(\)/);
  });
  it("trips when a question fails or times out, in the sort and in the single questions", () => {
    expect(main.match(/routerBreaker\.trip\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("is closed again when the router answers (a real ask, and the background warm)", () => {
    expect(main.match(/routerBreaker\.close\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("no ask reaches the server before the warm gate opens, and the gate resets when the server changes", () => {
    expect(main.match(/routerWarmGate\.open/g)?.length).toBeGreaterThanOrEqual(2); // the ask paths (sort + single questions)
    expect(main.match(/routerWarmGate\.markWarmed\(\)/g)?.length).toBeGreaterThanOrEqual(2); // a real reply, and the warm's reply
    expect(main).toMatch(/routerWarmGate\.reset\(\)/); // a fresh (spawned or adopted) server must load again
  });
  /**
   * From an on-device test run ("the model call router:warm failed: the server sent
   * nothing for 45 s ..."): the fail-fast recovery of a ROUTER call walked into the
   * chat host's recovery — it stopped the CHAT's model server and asked the host to
   * start the router model in its place, putting the user's chat model out mid-turn.
   * The router's server is this process's own: a stalled router call is recovered by
   * recycling the router's server, and only a non-router entry falls through to the
   * chat host.
   */
  it("a stalled router call is recovered by the router's own server, never the chat's", () => {
    const at = main.indexOf("recoverServer: async");
    expect(at).toBeGreaterThan(0);
    const body = main.slice(at, at + 900);
    expect(body).toContain("ensureRouterServer"); // the router recycles its own server first
    expect(body).not.toMatch(/stopServerHost[\s\S]*ensureRouterServer/); // the chat host is touched only after the router check
  });
});
