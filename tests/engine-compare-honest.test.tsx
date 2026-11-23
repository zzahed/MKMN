// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { EngineCompare } from "../src/renderer/EngineCompare";

/**
 * The one-click engine comparison is not in the desktop build: its button promised
 * "Install Foundry Local and compare" and only said so after the click. The state
 * now says it up front, and the button is disabled with the reason beside it.
 */

afterEach(() => { cleanup(); });

describe("Engine Comparison says what it cannot do before the click", () => {
  it("disables the one-click comparison and names the way that works", async () => {
    const api: Record<string, any> = {
      foundryStatus: async () => ({ installed: false, pairs: [], log: [] }),
      benchState: async () => ({ running: false, rows: [] }),
      engineCompareState: async () => ({ running: false, steps: [], unavailable: "Not in this build yet: tick pairs below and run them with the benchmark." }),
    };
    (window as any).mkmn = new Proxy(api, { get: (t, p: string) => (p in t ? t[p] : p.startsWith("on") ? () => () => {} : async () => undefined) });
    render(createElement(EngineCompare as any, {}));
    const btn = await screen.findByRole("button", { name: /compare/i });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/Not in this build yet/)).toBeTruthy();
  });

  it("the desktop bridge reports the comparison as unavailable in its state", async () => {
    const src = (await import("node:fs")).readFileSync("src/renderer/tauriBridge.ts", "utf8");
    const at = src.indexOf("async engineCompareState()");
    expect(src.slice(at, at + 400)).toMatch(/unavailable:/);
  });
});
