// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { VoiceSetup } from "../src/renderer/VoiceSetup";

/**
 * The voice install dialog is a modal: focus moves into it when it opens, Escape
 * closes it, and focus goes back to what opened it. "Choose in settings" opens the
 * Voice group (it opened Chats & answers).
 */

afterEach(() => { cleanup(); });

describe("the voice install dialog", () => {
  it("takes focus when it opens, closes on Escape, and gives focus back", async () => {
    (window as any).mkmn = new Proxy({}, { get: (_t, p: string) => (p.startsWith("on") ? () => () => {} : async () => []) });
    Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onCancel = vi.fn();
    render(createElement(VoiceSetup, { kinds: ["stt"], pack: null, onDone: () => {}, onCancel, onSettings: () => {} }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    opener.remove();
  });

  it("Choose in settings opens the Voice group (source pin)", () => {
    const chat = readFileSync("src/renderer/Chat.tsx", "utf8");
    expect(chat).toMatch(/onSettings=\{\(\) => \{ setVoiceSetup\(null\); onOpenSettings\("voice"\); \}\}/);
  });
});
