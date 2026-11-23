// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { ArtifactViewer } from "../src/renderer/ArtifactView";

/**
 * A request the backend rejects must end the state it began: the viewer stayed on
 * "Running" when runCode was refused, and on "Opening…" when launchSite was.
 */

afterEach(() => { cleanup(); });

function bridge(over: Record<string, any>) {
  (window as any).mkmn = new Proxy(over, { get: (t, p: string) => (p in t ? t[p] : p.startsWith("on") ? () => () => {} : async () => undefined) });
  (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Element.prototype.scrollIntoView = () => {}; // jsdom does no layout
}

describe("the file viewer never stays stuck on a refused request", () => {
  it("a refused run ends as failed, with the reason", async () => {
    bridge({ runCode: vi.fn(async () => { throw new Error("the engine is not running"); }) });
    render(createElement(ArtifactViewer as any, { artifact: { title: "hello.py", kind: "code", language: "python", content: "print(1)" }, onClose: () => {} }));
    fireEvent.click(await screen.findByRole("button", { name: /Run$/ }));
    await waitFor(() => expect(screen.getByText(/the engine is not running/)).toBeTruthy());
  });

  it("a refused open says why instead of staying on Opening…", async () => {
    bridge({ launchSite: vi.fn(async () => { throw new Error("no browser could be started"); }) });
    render(createElement(ArtifactViewer as any, { artifact: { title: "index.html", kind: "html", language: "html", content: "<p>hi</p>" }, onClose: () => {} }));
    fireEvent.click(await screen.findByRole("button", { name: /browser/i }));
    await waitFor(() => expect(screen.getByText(/no browser could be started/)).toBeTruthy());
  });
});
