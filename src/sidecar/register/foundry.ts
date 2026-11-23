// The Microsoft Foundry Local methods of the sidecar: engine status, the catalog it adds,
// and the Developer settings' management of its CLI (config, cache, server, logs, models,
// transcription, report). Moved out of main.ts as they were; main.ts owns the Foundry host,
// the catalog discovery and the NPU owner, and passes them in.
import * as fs from "fs";
import { findFoundry, type FoundryActionResult, type FoundryAdminView, type FoundryHost, type FoundryServerActionResult } from "../../core/foundryHost";
import { runtimeLease } from "../../core/lease";
import type { NpuOwner } from "../../core/npuOwner";
import type { CatalogEntry } from "../../shared/types";
import type { SidecarDispatcher } from "../protocol";

export interface FoundryDeps {
  /** The Foundry Local CLI, found and version-checked once; null when it is not installed. */
  foundryHost: () => Promise<FoundryHost | null>;
  /** Foundry's catalog entries, discovered again after a change to its cache or models. */
  foundryEntries: () => Promise<CatalogEntry[]>;
  npuOwner: NpuOwner;
}

export function registerFoundry(dispatcher: SidecarDispatcher, { foundryHost, foundryEntries, npuOwner }: FoundryDeps): void {
  // ---- Foundry Local engine status (Tauri build: discovered + version-checked by the sidecar)

  dispatcher.register("foundryStatus", async () => {
    const f = await foundryHost();
    if (!f) return { installed: false, version: null, loaded: null, cached: null, note: "foundry.exe was not found (or it did not answer --version)" };
    const list = await f.cached().catch(() => null);
    return {
      installed: true,
      version: f.features.version,
      loaded: f.loaded,
      cached: list?.length ?? null,
      note: f.statusLine(),
    };
  });

  dispatcher.register("foundryEntries", async () => {
    try { return await foundryEntries(); } catch { return []; }
  });

  // ---- Foundry Local management (Developer settings): the same CLI, read and written in one place

  const foundryMissing = (): FoundryActionResult => ({
    ok: false,
    message: "Microsoft Foundry Local is not installed (or its version could not be read). Install it first, then refresh."
  });

  function existingFolder(value: unknown): string | null {
    const p = typeof value === "string" ? value.trim() : "";
    if (!p || p.length > 2_000) return null;
    try { return fs.statSync(p).isDirectory() ? p : null; } catch { return null; }
  }

  function existingFile(value: unknown): string | null {
    const p = typeof value === "string" ? value.trim() : "";
    if (!p || p.length > 2_000) return null;
    try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
  }

  dispatcher.register("foundryAdmin", async (): Promise<FoundryAdminView> => {
    const exe = findFoundry(process.env, (p) => { try { return fs.existsSync(p); } catch { return false; } });
    const f = await foundryHost();
    if (!f) {
      return {
        installed: false, version: null, exe, error: "foundry.exe was not found (or it did not answer --version).",
        server: null, config: null, cacheLocation: null, cache: null, status: null, statusText: "", recent: []
      };
    }
    const [server, config, cacheLocation, cache, diagnostics] = await Promise.all([
      f.serverStatus().catch(() => null),
      f.config().catch(() => null),
      f.cacheLocation().catch(() => null),
      f.cached().catch(() => null),
      f.diagnostics().catch(() => ({ data: null, text: "" }))
    ]);
    return {
      installed: true,
      version: f.features.version,
      exe,
      server,
      config,
      cacheLocation,
      cache,
      status: diagnostics.data,
      statusText: diagnostics.text,
      recent: f.recent.slice(-40)
    };
  });

  dispatcher.register("foundryConfigSet", async (key: string, value: string): Promise<FoundryActionResult> => {
    const f = await foundryHost();
    if (!f) return foundryMissing();
    return f.configSet(String(key ?? ""), String(value ?? ""));
  });

  dispatcher.register("foundryConfigReset", async (key?: string): Promise<FoundryActionResult> => {
    const f = await foundryHost();
    if (!f) return foundryMissing();
    return f.configReset(key ? String(key) : undefined);
  });

  dispatcher.register("foundryCacheSet", async (target: string): Promise<FoundryActionResult> => {
    const f = await foundryHost();
    if (!f) return foundryMissing();
    const folder = existingFolder(target);
    if (!folder) return { ok: false, message: "That folder does not exist. Choose an existing folder Foundry may use for its cache." };
    const r = await f.cacheSet(folder);
    if (r.ok) void foundryEntries().catch(() => undefined);
    return r;
  });

  dispatcher.register("foundryCacheRemove", async (alias?: string): Promise<FoundryActionResult> => {
    const f = await foundryHost();
    if (!f) return foundryMissing();
    const a = typeof alias === "string" && alias.trim() ? alias.trim().slice(0, 300) : undefined;
    const r = await f.cacheRemove(a);
    if (r.ok) void foundryEntries().catch(() => undefined);
    return r;
  });

  dispatcher.register("foundryServer", async (action: string, opts?: { port?: number | null; idleTimeoutMinutes?: number | null }): Promise<FoundryServerActionResult> => {
    const f = await foundryHost();
    if (!f) return { ...foundryMissing(), server: null };
    if (!["start", "stop", "restart"].includes(action)) {
      return { ok: false, message: "The server action must be start, stop or restart.", server: await f.serverStatus().catch(() => null) };
    }
    const port = opts?.port === undefined || opts?.port === null ? null : Number(opts.port);
    const idle = opts?.idleTimeoutMinutes === undefined || opts?.idleTimeoutMinutes === null ? null : Number(opts.idleTimeoutMinutes);
    return f.serverAction(action as "start" | "stop" | "restart", { port, idleTimeoutMinutes: idle });
  });

  dispatcher.register("foundryLogs", async (lines?: number): Promise<string> => {
    const f = await foundryHost();
    if (!f) return "";
    const n = Number.isFinite(Number(lines)) ? Math.min(2_000, Math.max(1, Math.floor(Number(lines)))) : 50;
    return f.logs(n);
  });

  dispatcher.register("foundryModelInfo", async (alias: string) => {
    const f = await foundryHost();
    if (!f) return { info: null, text: "" };
    return f.modelInfo(String(alias ?? ""));
  });

  dispatcher.register("foundryModelRegister", async (input: Record<string, unknown>): Promise<FoundryActionResult> => {
    const f = await foundryHost();
    if (!f) return foundryMissing();
    const folder = existingFolder(input?.path);
    if (!folder) return { ok: false, message: "That model folder does not exist." };
    const r = await f.registerModel({
      path: folder,
      modelId: String(input?.modelId ?? ""),
      task: String(input?.task ?? ""),
      displayName: typeof input?.displayName === "string" ? input.displayName : undefined,
      device: typeof input?.device === "string" ? input.device : undefined,
      executionProvider: typeof input?.executionProvider === "string" ? input.executionProvider : undefined,
      contextLength: input?.contextLength === undefined || input?.contextLength === null ? undefined : Number(input.contextLength)
    });
    if (r.ok) void foundryEntries().catch(() => undefined);
    return r;
  });

  dispatcher.register("foundryModelUnregister", async (alias: string): Promise<FoundryActionResult> => {
    const f = await foundryHost();
    if (!f) return foundryMissing();
    const r = await f.unregisterModel(String(alias ?? ""));
    if (r.ok) void foundryEntries().catch(() => undefined);
    return r;
  });

  dispatcher.register("foundryModelLoad", async (alias: string, device?: string | null): Promise<FoundryActionResult> => {
    const f = await foundryHost();
    if (!f) return foundryMissing();
    const dev = typeof device === "string" && /^(cpu|gpu|npu)$/i.test(device) ? device.toUpperCase() : null;
    if (runtimeLease.isBusy()) return { ok: false, message: "A model task is running. Wait for it to finish, then retry." };
    const r = await npuOwner.run("foundry", () => f.loadModel(String(alias ?? ""), dev));
    return r;
  });

  dispatcher.register("foundryModelUnload", async (alias: string): Promise<FoundryActionResult> => {
    const f = await foundryHost();
    if (!f) return foundryMissing();
    return f.unloadModel(String(alias ?? ""));
  });

  dispatcher.register("foundryTranscribe", async (input: { file?: string; model?: string; language?: string }) => {
    const f = await foundryHost();
    if (!f) return { ok: false, error: "Microsoft Foundry Local is not installed (or its version could not be read)." };
    const file = existingFile(input?.file);
    if (!file) return { ok: false, error: "That audio file does not exist." };
    if (runtimeLease.isBusy()) return { ok: false, error: "A model task is running. Wait for it to finish, then retry." };
    return npuOwner.run("foundry", () => f.transcribe({
      file,
      model: typeof input?.model === "string" ? input.model : undefined,
      language: typeof input?.language === "string" ? input.language : undefined
    }));
  });

  dispatcher.register("foundryReport", async (): Promise<{ ok: boolean; message: string }> => {
    const f = await foundryHost();
    if (!f) return { ok: false, message: "Microsoft Foundry Local is not installed (or its version could not be read)." };
    return f.foundryReport();
  });
}
