// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { FoundryPanel } from "../src/renderer/FoundryPanel";
import type { FoundryAdminView } from "../src/core/foundryHost";

/**
 * The Developer Foundry panel reads one report and offers Foundry's own actions.
 * It must show the endpoint Foundry reported (never one chosen here), expose each
 * cached model's execution provider, and send the documented commands through
 * the bridge.
 */

afterEach(() => { cleanup(); });

const VIEW: FoundryAdminView = {
  installed: true,
  version: "0.12.1",
  exe: "C:\\WindowsApps\\foundry.exe",
  server: {
    running: true,
    state: "ready",
    pid: 4242,
    webUrls: ["http://127.0.0.1:50798"],
    startedAt: "2026-11-04T21:22:07Z",
    uptime: "8d 11h",
    logFile: "C:\\Users\\me\\.foundry\\foundry.log"
  },
  config: [
    { key: "port", value: "auto", userSet: false },
    { key: "cache-directory", value: "C:\\Users\\me\\.foundry\\cache\\models", userSet: false },
    { key: "idle-timeout-minutes", value: "disabled", userSet: false },
    { key: "log-level", value: "info", userSet: true }
  ],
  cacheLocation: { path: "C:\\Users\\me\\.foundry\\cache\\models", userSet: false },
  cache: [
    { alias: "deepseek-r1-7b", device: "NPU", sizeGB: 3.71, loaded: false },
    { alias: "qwen3-0.6b", device: "CPU", sizeGB: 0.58, loaded: true }
  ],
  status: {
    system: {
      operatingSystem: "Windows 11",
      architecture: "Arm64",
      cpu: "Snapdragon X2 Elite",
      logicalCores: 18,
      physicalCores: 18,
      totalMemoryBytes: 32 * 1024 ** 3,
      availableMemoryBytes: 12 * 1024 ** 3,
      diskPath: "C:\\",
      diskTotalBytes: 1024 * 1024 ** 3,
      diskFreeBytes: 80 * 1024 ** 3,
      gpus: [{ name: "Adreno X2-90", vendor: null, videoMemoryBytes: 128 * 1024 ** 2 }],
      npus: [{ name: "Hexagon NPU", vendor: "Qualcomm" }]
    },
    service: { state: "ready", ready: true, webUrls: ["http://127.0.0.1:50798"], versions: { cliVersion: "0.12.1" } },
    models: { available: 109, loaded: 1, cached: 2 },
    connectivity: { localServiceReachable: true, modelRegistryReachable: true },
    warnings: []
  },
  statusText: "",
  recent: ["$ foundry --version → 0.12.1"]
};

function install(view: FoundryAdminView, extra: Record<string, any> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const api: Record<string, any> = {
    foundryAdmin: async () => view,
    foundryConfigSet: async (...args: unknown[]) => { calls.push({ method: "foundryConfigSet", args }); return { ok: true, message: "saved" }; },
    foundryConfigReset: async (...args: unknown[]) => { calls.push({ method: "foundryConfigReset", args }); return { ok: true, message: "reset" }; },
    foundryCacheSet: async (...args: unknown[]) => { calls.push({ method: "foundryCacheSet", args }); return { ok: true, message: "moved" }; },
    foundryCacheRemove: async (...args: unknown[]) => { calls.push({ method: "foundryCacheRemove", args }); return { ok: true, message: "removed" }; },
    foundryServer: async (...args: unknown[]) => { calls.push({ method: "foundryServer", args }); return { ok: true, message: "done", server: view.server }; },
    foundryLogs: async (...args: unknown[]) => { calls.push({ method: "foundryLogs", args }); return "line one\nline two"; },
    foundryModelInfo: async (...args: unknown[]) => {
      calls.push({ method: "foundryModelInfo", args });
      return {
        info: {
          alias: "qwen3-0.6b", id: "qwen3-0.6b-generic-cpu:4", displayName: "qwen3-0.6b-generic-cpu",
          source: "Public", task: "Chat", device: "CPU", publisher: "Microsoft", license: "apache-2.0",
          sizeGB: 0.58, cached: true, supportsToolCalling: true,
          variants: [{ id: "qwen3-0.6b-generic-cpu:4", displayName: "CPU build", device: "CPU", executionProvider: "CPUExecutionProvider", sizeGB: 0.58, cached: true }]
        },
        text: ""
      };
    },
    foundryModelLoad: async (...args: unknown[]) => { calls.push({ method: "foundryModelLoad", args }); return { ok: true, message: "loaded" }; },
    foundryModelUnload: async (...args: unknown[]) => { calls.push({ method: "foundryModelUnload", args }); return { ok: true, message: "unloaded" }; },
    foundryModelRegister: async (...args: unknown[]) => { calls.push({ method: "foundryModelRegister", args }); return { ok: true, message: "registered" }; },
    foundryModelUnregister: async (...args: unknown[]) => { calls.push({ method: "foundryModelUnregister", args }); return { ok: true, message: "unregistered" }; },
    foundryTranscribe: async (...args: unknown[]) => { calls.push({ method: "foundryTranscribe", args }); return { ok: true, text: "hello" }; },
    foundryReport: async (...args: unknown[]) => { calls.push({ method: "foundryReport", args }); return { ok: true, message: "GitHub issue opened (demo)." }; },
    foundryPickAudio: async () => "C:\\audio\\note.wav",
    pickFolder: async () => "D:\\foundry-cache",
    ...extra
  };
  (window as any).mkmn = new Proxy(api, { get: (t, p: string) => (p in t ? t[p] : async () => undefined) });
  return calls;
}

describe("the Foundry Local Developer panel", () => {
  it("shows the reported endpoint, settings and cached models", async () => {
    install(VIEW);
    render(createElement(FoundryPanel));
    expect(await screen.findByText("http://127.0.0.1:50798")).toBeTruthy();
    expect(screen.getByText("deepseek-r1-7b")).toBeTruthy();
    expect(screen.getByText("qwen3-0.6b")).toBeTruthy();
    expect(screen.getByText("Foundry Local 0.12.1")).toBeTruthy();
    // the four documented settings, with the CLI's own values
    expect((screen.getByDisplayValue("auto") as HTMLInputElement).value).toBe("auto");
    expect((screen.getByDisplayValue("disabled") as HTMLInputElement).value).toBe("disabled");
    expect((screen.getByDisplayValue("info") as HTMLInputElement).value).toBe("info");
  });

  it("saves a setting, stops the server, and loads a cached model", async () => {
    const calls = install(VIEW);
    render(createElement(FoundryPanel));
    await screen.findByText("http://127.0.0.1:50798");

    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(calls.some((c) => c.method === "foundryConfigSet")).toBe(true));
    expect(calls.find((c) => c.method === "foundryConfigSet")?.args).toEqual(["port", "auto"]);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls.some((c) => c.method === "foundryServer")).toBe(true));
    expect(calls.find((c) => c.method === "foundryServer")?.args[0]).toBe("stop");

    fireEvent.click(screen.getAllByRole("button", { name: "Load" })[0]);
    await waitFor(() => expect(calls.some((c) => c.method === "foundryModelLoad")).toBe(true));
    expect(calls.find((c) => c.method === "foundryModelLoad")?.args).toEqual(["deepseek-r1-7b", "NPU"]);
  });

  it("reads details with execution providers and transcribes a picked file", async () => {
    const calls = install(VIEW);
    render(createElement(FoundryPanel));
    await screen.findByText("http://127.0.0.1:50798");

    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[0]);
    expect(await screen.findByText("CPUExecutionProvider")).toBeTruthy();
    expect(calls.find((c) => c.method === "foundryModelInfo")?.args).toEqual(["deepseek-r1-7b"]);

    const audioBrowse = screen.getAllByRole("button", { name: "Browse…" }).at(-1)!;
    fireEvent.click(audioBrowse);
    await waitFor(() => expect((screen.getByPlaceholderText(/Choose a wav/) as HTMLInputElement).value).toBe("C:\\audio\\note.wav"));
    fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(calls.find((c) => c.method === "foundryTranscribe")?.args[0]).toMatchObject({ file: "C:\\audio\\note.wav" });
  });

  it("offers to install Foundry when it is missing, and no other controls", async () => {
    install({ ...VIEW, installed: false, version: null, server: null, config: null, cacheLocation: null, cache: null, status: null, error: "foundry.exe was not found." });
    render(createElement(FoundryPanel));
    expect(await screen.findByText(/foundry.exe was not found/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install Foundry Local" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove all cached models" })).toBeNull();
  });
});

describe("Foundry Local missing", () => {
  it("installs it from the panel and reads the panel again", async () => {
    let installed = false;
    const calls = install({ ...VIEW, installed: false } as FoundryAdminView, {
      foundryAdmin: async () => (installed ? VIEW : { ...VIEW, installed: false }),
      installRequirement: async (id: string) => { calls.push({ method: "installRequirement", args: [id] }); installed = true; return { ok: true, message: "Microsoft Foundry Local is installed." }; }
    });
    render(createElement(FoundryPanel));
    fireEvent.click(await screen.findByRole("button", { name: "Install Foundry Local" }));
    await waitFor(() => expect(calls.some((c) => c.method === "installRequirement" && c.args[0] === "foundry")).toBe(true));
    expect(await screen.findByText("Microsoft Foundry Local is installed.")).toBeTruthy();
    expect(await screen.findByText("http://127.0.0.1:50798")).toBeTruthy();
  });
});
