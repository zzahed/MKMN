import { afterEach, describe, expect, it } from "vitest";
import { isolation, IsolationUnsafeError, lockedNodeArgs, readReply, setIsolation, type IsolationRunner } from "../src/core/isolate";

/**
 * The reply of the locked-down process that ran generated code. Only a well-formed
 * `{ ok: true }` line is a result: a crash, a refusal by the permission model, output that
 * is not JSON or a reply that says it failed must each surface as an error, never as a value.
 */

describe("readReply", () => {
  it("returns the value of an ok reply, read from the last line (the code may print before it)", () => {
    expect(readReply('console noise\r\n{"ok":true,"value":{"ok":true,"failures":[]}}\r\n', "", 0)).toEqual({ ok: true, failures: [] });
    expect(readReply('{"ok":true}', "", 0)).toBeUndefined();
  });

  it("raises the error a failed reply carries", () => {
    expect(() => readReply('{"ok":false,"error":"add is not defined"}', "", 0)).toThrow("add is not defined");
  });

  it("raises a plain failure for a failed reply with no error", () => {
    expect(() => readReply('{"ok":false}', "", 0)).toThrow("the isolated check failed");
  });

  it("names the exit code and the last line of stderr when the process stopped without a reply", () => {
    const stderr = "node:internal/x\nError: Access to this API has been restricted\r\n  code: 'ERR_ACCESS_DENIED'\n";
    expect(() => readReply("", stderr, 1)).toThrow("the isolated check stopped (exit 1):   code: 'ERR_ACCESS_DENIED'");
  });

  it("leaves out the exit code when there is none (the process was killed)", () => {
    expect(() => readReply("half a line", "", null)).toThrow(/^the isolated check stopped: half a line$/);
  });

  it("falls back to stdout, and keeps 200 characters of a long line", () => {
    const long = "x".repeat(500);
    let msg = "";
    try { readReply(long, "", 2); } catch (e) { msg = (e as Error).message; }
    expect(msg).toBe(`the isolated check stopped (exit 2): ${"x".repeat(200)}`);
  });

  it("says there was no output when the process printed nothing", () => {
    expect(() => readReply("", "", 1)).toThrow("the isolated check stopped (exit 1): no output");
    expect(() => readReply("  \r\n", " \n", null)).toThrow("the isolated check stopped: no output");
  });
});

describe("lockedNodeArgs", () => {
  it("turns the permission model on, switches node:sqlite off and grants read access to the given folders only", () => {
    expect(lockedNodeArgs(["C:\\app\\dist", "C:\\app\\node_modules"], "w.js"))
      .toEqual(["--permission", "--no-experimental-sqlite", "--allow-fs-read=C:\\app\\dist", "--allow-fs-read=C:\\app\\node_modules", "w.js"]);
    const args = lockedNodeArgs([], "w.js");
    expect(args).toEqual(["--permission", "--no-experimental-sqlite", "w.js"]);
    expect(args.join(" ")).not.toMatch(/allow-(fs-write|child-process|worker|addons|net|wasi)/);
  });
});

describe("the installed runner", () => {
  afterEach(() => setIsolation(null));
  it("is the one last set, and none once cleared", () => {
    const r: IsolationRunner = { run: async () => 1, runSync: () => 1 };
    setIsolation(r);
    expect(isolation()).toBe(r);
    setIsolation(null);
    expect(isolation()).toBeNull();
  });
});

describe("IsolationUnsafeError", () => {
  it("says code is turned off, or paused when the check could not tell", () => {
    expect(new IsolationUnsafeError().message).toMatch(/turned off/);
    expect(new IsolationUnsafeError(true).message).toMatch(/paused.*checks again on the next run/);
    expect(new IsolationUnsafeError(true)).toBeInstanceOf(Error);
  });
});
