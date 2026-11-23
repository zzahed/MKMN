// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { Requirements } from "../src/renderer/Requirements";

afterEach(() => { cleanup(); });

function mount(statuses: { id: string; present: boolean; detail: string | null }[][]) {
  const installs: string[] = [];
  let round = 0;
  (window as any).mkmn = {
    requirements: async () => statuses[Math.min(round++, statuses.length - 1)],
    installRequirement: async (id: string) => { installs.push(id); return { ok: true, message: "LibreOffice is installed." }; }
  };
  render(createElement(Requirements));
  return installs;
}
const ALL = (missing: string[]) => ["webview2", "geniex", "npuDriver", "models", "voiceRuntime", "foundry", "python", "libreoffice"].map((id) => ({ id, present: !missing.includes(id), detail: null }));

describe("the requirements list in Settings", () => {
  it("lists every requirement with whether it is needed and whether it is here", async () => {
    mount([ALL(["python"])]);
    expect(await screen.findByText("Microsoft Edge WebView2 Runtime")).toBeTruthy();
    expect(screen.getAllByText("Required").length).toBe(4);
    await waitFor(() => expect(screen.getAllByText("Missing").length).toBe(1));
  });

  it("installs a missing package from its row, then checks again", async () => {
    const installs = mount([ALL(["libreoffice"]), ALL([])]);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(installs).toEqual(["libreoffice"]));
    expect(await screen.findByText("LibreOffice is installed.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Missing")).toBeNull());
  });

  it("checks for updates only when asked, and updates a package from its row", async () => {
    const calls: string[] = [];
    let geniexInstalls = 0;
    (window as any).mkmn = {
      requirements: async () => ALL([]),
      requirementUpdates: async () => { calls.push("check"); return { ok: true, message: "1 update available.", updates: [{ id: "foundry", pkg: "Microsoft.FoundryLocal", current: "0.12.1.0", available: "0.14.0.0" }], geniex: { installed: "v0.10.0", newer: true } }; },
      updateRequirement: async (id: string, pkg: string) => { calls.push(`${id}:${pkg}`); return { ok: true, message: "Microsoft Foundry Local is up to date." }; },
      openGeniexDownload: async () => { geniexInstalls++; },
    };
    render(createElement(Requirements));
    await screen.findByText("Microsoft Foundry Local");
    expect(calls).toEqual([]); // nothing is looked up on opening the page
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update to 0.14.0.0" }));
    await waitFor(() => expect(calls).toEqual(["check", "foundry:Microsoft.FoundryLocal"]));
    expect(await screen.findByText("Microsoft Foundry Local is up to date.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Update to 0.14.0.0" })).toBeNull());
    // GenieX goes through MKMN's own signed install, not a package
    fireEvent.click(screen.getByRole("button", { name: "Update GenieX" }));
    await waitFor(() => expect(geniexInstalls).toBe(1));
  });

  it("sends a missing driver to Windows Update, never to a download of its own", async () => {
    mount([ALL(["npuDriver"])]);
    const link = await screen.findByRole("link", { name: "Windows Update" });
    expect(link.getAttribute("href")).toBe("ms-settings:windowsupdate");
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });
});
