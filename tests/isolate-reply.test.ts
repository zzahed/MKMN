import { afterEach, describe, expect, it } from "vitest";
import { isolation, IsolationUnsafeError, lockedNodeArgs, readReply, replyPrefix, setIsolation, type IsolationRunner } from "../src/core/isolate";

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

  it("with a nonce, reads only the line that starts with it, wherever it stands", () => {
    const mine = `${replyPrefix("ab12")}"ok":true,"value":1}`;
    expect(readReply(`noise\n${mine}\n{"ok":true,"value":2}\n`, "", 0, "ab12")).toBe(1);
  });

  it("with a nonce, a reply without it, with another one, or twice over is no reply", () => {
    const stopped = /^the isolated check stopped/;
    expect(() => readReply('{"ok":true,"value":{"ok":true,"failures":[]}}', "", 0, "ab12")).toThrow(stopped);
    expect(() => readReply(`${replyPrefix("ffff")}"ok":true,"value":1}`, "", 0, "ab12")).toThrow(stopped);
    const mine = `${replyPrefix("ab12")}"ok":true,"value":1}`;
    expect(() => readReply(`${mine}\n${mine}`, "", 0, "ab12")).toThrow(stopped);
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
  it("turns the permission model on, switches node:sqlite off, freezes the builtins and grants read access to the given folders only", () => {
    expect(lockedNodeArgs(["C:\\app\\dist", "C:\\app\\node_modules"], "w.js"))
      .toEqual(["--permission", "--no-experimental-sqlite", "--frozen-intrinsics", "--disable-warning=ExperimentalWarning", "--allow-fs-read=C:\\app\\dist", "--allow-fs-read=C:\\app\\node_modules", "w.js"]);
    const args = lockedNodeArgs([], "w.js");
    expect(args).toEqual(["--permission", "--no-experimental-sqlite", "--frozen-intrinsics", "--disable-warning=ExperimentalWarning", "w.js"]);
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
