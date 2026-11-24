// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import type { GameSpec } from "../src/core/engine";

// The icon table never lands in this file: loadIcons() stays pending and the lookups
// find nothing, exactly like the first moments of the app before the table arrives.
vi.mock("../src/core/page/iconTable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/page/iconTable")>();
  return { ...actual, iconPaths: () => ({}), iconTags: () => ({}), isLoaded: () => false, loadIcons: () => new Promise<void>(() => {}) };
});
// the visual editor itself is not under test here — only whether it is drawn at all
vi.mock("@puckeditor/core", () => ({
  Puck: () => <div data-testid="puck-stub" />,
  legacySideBarPlugin: () => ({ name: "legacy-side-bar" }),
}));

describe("while the icon table has not landed", () => {
  const spec: GameSpec = {
    title: "Stars", things: [{ name: "player", shape: "icon", icon: "rocket", w: 36, h: 36, control: "horizontal" }, { name: "star", shape: "icon", icon: "star", vy: 120, edges: "remove" }],
    rules: [{ when: { hit: ["player", "star"] }, do: [{ op: "score", by: 1 }, { op: "remove", who: "b" }] }, { when: { every: 1 }, do: [{ op: "spawn", name: "star", at: "top" }] }, { when: { score: 10 }, do: [{ op: "win", text: "You win" }] }]
  };

  it("gameFlaw reports no icon fault on a valid icon shape (the fault would be a lie)", async () => {
    const { gameFlaw } = await import("../src/core/engine");
    expect(gameFlaw(spec).join(" ")).not.toContain("shape icon needs");
  });

  it("healGame does not turn a real icon shape into a circle", async () => {
    const { healGame } = await import("../src/core/engine");
    const { spec: mended } = healGame(spec);
    expect(mended.things.find((t) => t.name === "player")?.shape).toBe("icon");
    expect(mended.things.find((t) => t.name === "star")?.shape).toBe("icon");
  });

  it("the blocks editor does not draw before the table arrives", async () => {
    const { default: PageEditor } = await import("../src/renderer/PageEditor");
    const { render } = await import("@testing-library/react");
    const { createElement } = await import("react");
    const { container } = render(createElement(PageEditor, { spec: { title: "P", sections: [] } as never, onSave: () => {}, onClose: () => {} }));
    expect(container.querySelector("[data-testid='puck-stub']")).toBeNull();
    expect(container.textContent).toContain("Loading the editor…");
  });
});
