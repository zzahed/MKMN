// The sidecar's methods, as registered on its dispatcher. src/sidecar/main.ts keeps start-up
// and registers seven areas from their own files (src/sidecar/register/*.ts); moving a method
// between files must not lose, rename or add one. Importing main.ts would start the sidecar, so the registrations are read from the
// source: every `dispatcher.register("<name>"` under src/sidecar, and every area's
// `registerX` must be called from main.ts, or its methods would never be registered.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sidecarMethods } from "../scripts/feature-matrix.mjs";

const SIDECAR = "src/sidecar";
const AREAS = join(SIDECAR, "register");
const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourcesUnder(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
const registered = (): string[] =>
  sourcesUnder(SIDECAR).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/dispatcher\.register\("([^"]+)"/g)].map((m) => m[1]));

const METHODS = [
    "abortChat", "adaptiveStatus", "agentDocEdit", "agentDocEditDecide", "agentRun", "agentStopRun",
    "appShutdown", "batteryRead", "benchExport", "benchImportResults", "benchResults", "benchReveal",
    "benchRoster", "benchStart", "benchState", "benchStop", "benchmarkGeniexModel", "browse",
    "cancelInstall", "cancelSpeak", "chat", "compactChat", "compiledContexts", "convertLegacyDoc",
    "customEntries", "deleteTask", "dockerVariants", "fetchLibrary", "fixBlock", "forgetConversation",
    "foundryAdmin", "foundryCacheRemove", "foundryCacheSet", "foundryConfigReset", "foundryConfigSet",
    "foundryEntries", "foundryLogs", "foundryModelInfo", "foundryModelLoad", "foundryModelRegister",
    "foundryModelUnload", "foundryModelUnregister", "foundryReport", "foundryServer", "foundryStatus",
    "foundryTranscribe", "geniexClean", "geniexConfigList", "geniexPullLocal", "geniexSetType",
    "hfSearch", "humainKeySaved", "humainModels", "humainOperation", "humainRealtimeClose",
    "humainRealtimeEvents", "humainRealtimeOpen", "humainRealtimeSend", "humainSaveKey", "install",
    "installDynamic", "installDynamicModel", "installRequirement", "knowledgeBuild", "knowledgeForget",
    "knowledgeStatus", "labStart", "labState", "labStop", "launchSite", "npuReset", "npuResetStatus",
    "npuTestRoster", "npuTestStart", "npuTestState", "npuTestStop", "openEditedCopy", "pickFolder",
    "ping", "preloadGeniexModel", "readMedia", "requirementUpdates", "requirements", "resolveModel",
    "resolveModelIdentity", "restartGeniexModel", "routerBench", "routerCandidates", "routerFileKind",
    "routerInstall", "routerStatus", "routerTest", "runCode", "runCommand", "runTask", "saveMedia",
    "saveTask", "saveVoice", "setupConfirm", "setupDecline", "setupDismiss", "setupRetry",
    "setupRunUnsigned", "setupSkip", "setupState", "skipStep", "speak", "speedsById", "speedsByRef",
    "startGeniexModel", "stopRun", "tasks", "transcribe", "uninstall", "uninstallDynamic",
    "unknownModelCheckState", "updateCheck", "updateForce", "updateInstall", "updateRequirement",
    "updateState", "vectorModelInstall", "vectorModelRemove", "vectorModelStatus", "voiceApply",
    "voiceCancelDownload", "voiceDownload", "voiceModels", "voiceNeeds", "voiceQuickInstall",
    "voiceRemove", "voiceStatus", "writeRun",
];

describe("the sidecar's registered methods", () => {
  it("are exactly the known list, each registered once", () => {
    const names = registered();
    expect(names.length, "a method is registered twice").toBe(new Set(names).size);
    expect([...names].sort()).toEqual(METHODS);
  });

  it("every area file's register function is called from main.ts", () => {
    if (!existsSync(AREAS)) return;
    const main = readFileSync(join(SIDECAR, "main.ts"), "utf8");
    for (const file of readdirSync(AREAS).filter((f) => f.endsWith(".ts"))) {
      const fns = [...readFileSync(join(AREAS, file), "utf8").matchAll(/export function (register\w+)\(/g)].map((m) => m[1]);
      expect(fns.length, `${file} exports no register function`).toBeGreaterThan(0);
      for (const fn of fns) expect(main, `${fn} (${file}) is not called from main.ts`).toMatch(new RegExp(`\\b${fn}\\(`));
    }
  });

  it("the feature matrix sees the same methods", () => {
    expect([...sidecarMethods()].sort()).toEqual(METHODS);
  });
});
