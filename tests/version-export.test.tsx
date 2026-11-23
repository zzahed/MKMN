// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { VersionedViewer } from "../src/renderer/VersionMenu";

/**
 * Save as exports what is on the screen. While an older version was shown, Save
 * as exported the file by its id — the version in use — under a screen showing
 * another text.
 */

afterEach(() => { cleanup(); });

const LIST = {
  artifactId: "a1", main: "v2",
  versions: [
    { id: "v1", n: 1, title: "First draft", at: Date.now() - 60_000, by: "model", parent: null, plus: 3, minus: 0 },
    { id: "v2", n: 2, title: "Made shorter", at: Date.now(), by: "model", parent: "v1", plus: 1, minus: 2 },
  ],
};

describe("Save as while an older version is shown", () => {
  it("exports that version's text, not the file in use", async () => {
    const base: Record<string, any> = {
      artifactVersions: vi.fn(async () => LIST),
      artifactVersionText: vi.fn(async () => "the OLD text"),
    };
    // every other bridge call the viewer makes: subscriptions return an unsubscribe, the rest resolve empty
    (window as any).mkmn = new Proxy(base, { get: (t, p: string) => (p in t ? t[p] : p.startsWith("on") ? () => () => {} : async () => undefined) });
    (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const onExport = vi.fn();
    const onExportVersion = vi.fn();
    render(createElement(VersionedViewer as any, {
      artifactId: "a1",
      artifact: { title: "notes.md", kind: "markdown", language: "markdown", content: "the CURRENT text" },
      onClose: () => {}, onExport, onExportVersion,
    }));
    fireEvent.click(await screen.findByRole("button", { name: /v2|version/i }));
    fireEvent.click(await screen.findByRole("option", { name: /First draft/ }));
    await screen.findByText(/Looking at/);
    fireEvent.click(screen.getByRole("button", { name: /Save as/ }));
    // a markdown file offers formats: pick the first one
    const item = screen.queryAllByRole("menuitem")[0];
    if (item) fireEvent.click(item);
    await waitFor(() => expect(onExportVersion).toHaveBeenCalled());
    expect(onExportVersion.mock.calls[0][1]).toBe("the OLD text");
    expect(onExportVersion.mock.calls[0][2]).toBe(1);
    expect(onExport).not.toHaveBeenCalled();
  });
});
