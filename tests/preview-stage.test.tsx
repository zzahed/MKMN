// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { ArtifactViewer } from "../src/renderer/ArtifactView";

/**
 * While a page was being built the preview stayed blank: the step the work was on
 * was only in the chat, which a narrow window hides behind the Preview tab. The
 * step is now shown where the preview will appear (centered while the file is
 * still empty, a strip once it draws), and only while it is being written.
 */

afterEach(() => { cleanup(); });

function bridge() {
  (window as any).mkmn = new Proxy({}, { get: (_t, p: string) => (p.startsWith("on") ? () => () => {} : async () => undefined) });
  (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Element.prototype.scrollIntoView = () => {};
}

const page = (content: string) => ({ title: "index.html", kind: "html", language: "html", content });

describe("the preview shows the build step while the file is written", () => {
  it("an empty page being written shows the step in the middle", () => {
    bridge();
    render(createElement(ArtifactViewer as any, { artifact: page(""), live: true, stage: "Planning the parts", onClose: () => {} }));
    const s = screen.getByRole("status");
    expect(s.textContent).toBe("Planning the parts");
    expect(s.className).toContain("empty");
  });

  it("a page that already draws keeps the step as a strip", () => {
    bridge();
    render(createElement(ArtifactViewer as any, { artifact: page("<p>hi</p>"), live: true, stage: "Checking index.html", onClose: () => {} }));
    expect(screen.getByRole("status").className).not.toContain("empty");
  });

  it("a finished file shows no step", () => {
    bridge();
    render(createElement(ArtifactViewer as any, { artifact: page("<p>hi</p>"), live: false, stage: "Checking index.html", onClose: () => {} }));
    expect(screen.queryByText("Checking index.html")).toBeNull();
  });

  it("the chat passes the run's current step only while the turn is being written", () => {
    const chat = readFileSync("src/renderer/Chat.tsx", "utf8");
    expect(chat).toContain("stage={viewed?.pending ? viewed.build?.phase : undefined}");
  });
});
