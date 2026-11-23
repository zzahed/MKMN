// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { ArtifactViewer } from "../src/renderer/ArtifactView";

/**
 * Navigation and slide picks from the preview are obeyed only when a preview frame
 * sent them, like the cell-edit and part-pick messages: any other window's message
 * is ignored.
 */

afterEach(() => { cleanup(); });

function bridge() {
  (window as any).mkmn = new Proxy({}, { get: (_t, p: string) => (p.startsWith("on") ? () => () => {} : async () => undefined) });
  (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Element.prototype.scrollIntoView = () => {};
}

describe("preview messages are obeyed only from a preview frame", () => {
  it("a slide pick posted by another window is ignored", async () => {
    bridge();
    const onPick = vi.fn();
    render(createElement(ArtifactViewer as any, { artifact: { title: "index.html", kind: "html", language: "html", content: "<p>hi</p>" }, onPick, onClose: () => {} }));
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { data: { npuPickSlide: 2 }, source: window })); });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("a slide pick posted by a preview frame is obeyed", async () => {
    bridge();
    const onPick = vi.fn();
    const { container } = render(createElement(ArtifactViewer as any, { artifact: { title: "index.html", kind: "html", language: "html", content: "<p>hi</p>" }, onPick, onClose: () => {} }));
    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { data: { npuPickSlide: 2 }, source: frame.contentWindow })); });
    expect(onPick).toHaveBeenCalledWith(2);
  });
});
