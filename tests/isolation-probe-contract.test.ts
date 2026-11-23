import { beforeEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({
  execFile: vi.fn((..._args: unknown[]): void => {}),
  spawnSync: vi.fn((..._args: unknown[]): { error?: Error; status: number | null; stdout: string } => ({
    status: 0, stdout: "ERR_ACCESS_DENIED\\n",
  })),
}));

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: child.execFile,
  spawnSync: child.spawnSync,
}));

import { proveNetworkDenied, proveNetworkDeniedSync } from "../src/sidecar/isolation";

const setAsyncReply = (error: Error | null, stdout: string) => {
  child.execFile.mockImplementation((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string) => void;
    callback(error, stdout);
  });
};

beforeEach(() => {
  child.execFile.mockReset();
  child.spawnSync.mockReset();
});

describe("isolation probe execution-contract handling", () => {
  it("never accepts a failed asynchronous child even if it printed a denial", async () => {
    setAsyncReply(new Error("process exited with code 1"), "ERR_ACCESS_DENIED\\n");
    expect(await proveNetworkDenied("node", [])).toBeNull();
  });

  it("never accepts a failed synchronous child even if it printed a denial", () => {
    child.spawnSync.mockReturnValue({ status: 1, stdout: "ERR_ACCESS_DENIED\\n" });
    expect(proveNetworkDeniedSync("node", [])).toBeNull();
  });

  it("does not accept a child terminated by a signal", () => {
    child.spawnSync.mockReturnValue({ status: null, stdout: "ERR_ACCESS_DENIED\\n" });
    expect(proveNetworkDeniedSync("node", [])).toBeNull();
  });

  it("rejects a synchronous spawn error regardless of stdout", () => {
    child.spawnSync.mockReturnValue({
      error: new Error("spawn failed"), status: null, stdout: "ERR_ACCESS_DENIED\\n",
    });
    expect(proveNetworkDeniedSync("node", [])).toBeNull();
  });

  it("accepts only successful child execution with explicit denial", async () => {
    setAsyncReply(null, "ERR_ACCESS_DENIED\\n");
    child.spawnSync.mockReturnValue({ status: 0, stdout: "ERR_ACCESS_DENIED\\n" });
    expect(await proveNetworkDenied("node", [])).toBe(true);
    expect(proveNetworkDeniedSync("node", [])).toBe(true);
  });

  it("rejects open-network outcomes even when child execution succeeds", async () => {
    setAsyncReply(null, "ECONNREFUSED\\n");
    child.spawnSync.mockReturnValue({ status: 0, stdout: "CONNECTED\\n" });
    expect(await proveNetworkDenied("node", [])).toBe(false);
    expect(proveNetworkDeniedSync("node", [])).toBe(false);
  });
});
