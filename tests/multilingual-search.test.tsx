// @vitest-environment jsdom
/**
 * Settings → Files & projects → Search across languages: nothing is
 * downloaded until Install is pressed; Remove asks first; an install that failed says
 * why. The sidecar side (pinned files, SHA-256 checks) is tests/knowledge-vectors.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MultilingualSearch } from "../src/renderer/MultilingualSearch";
import type { VectorModelStatusView } from "../src/shared/api";

const base: VectorModelStatusView = { installed: false, runtime: true, installing: false, bytes: 135391039, label: "Multilingual search model" };

function withApi(over: Partial<Record<"vectorModelStatus" | "vectorModelInstall" | "vectorModelRemove", () => Promise<VectorModelStatusView | null>>>) {
  const calls = { install: 0, remove: 0 };
  (window as unknown as { mkmn: unknown }).mkmn = {
    vectorModelStatus: over.vectorModelStatus ?? (async () => base),
    vectorModelInstall: over.vectorModelInstall ?? (async () => { calls.install++; return { ...base, installed: true }; }),
    vectorModelRemove: over.vectorModelRemove ?? (async () => { calls.remove++; return base; }),
  };
  return calls;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Search across languages", () => {
  it("downloads nothing until Install is pressed, then shows the model installed", async () => {
    const calls = withApi({});
    render(createElement(MultilingualSearch));
    const btn = await screen.findByRole("button", { name: "Install (129 MB)" });
    expect(calls.install).toBe(0);
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/^Installed/)).toBeTruthy());
    expect(calls.install).toBe(1);
  });

  it("Remove asks first, and Keep it leaves the model", async () => {
    const calls = withApi({ vectorModelStatus: async () => ({ ...base, installed: true }) });
    render(createElement(MultilingualSearch));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.getByText(/Remove the model \(129 MB\)\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(calls.remove).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).find((b) => b.className.includes("danger"))!);
    await waitFor(() => expect(calls.remove).toBe(1));
    expect(await screen.findByRole("button", { name: "Install (129 MB)" })).toBeTruthy();
  });

  it("an install that failed says why", async () => {
    withApi({ vectorModelInstall: async () => ({ ...base, error: "tokenizer.json did not match its published fingerprint" }) });
    render(createElement(MultilingualSearch));
    fireEvent.click(await screen.findByRole("button", { name: "Install (129 MB)" }));
    expect((await screen.findByRole("alert")).textContent).toContain("did not match its published fingerprint");
  });
});
