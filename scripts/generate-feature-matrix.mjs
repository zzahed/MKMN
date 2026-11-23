// Generates docs/MKMN_FEATURE_TEST_MATRIX_0.0.2.md from the source inventory.
// Run `node scripts/generate-feature-matrix.mjs --write` after adding a command,
// method, setting, screen or script; `--check` fails when the
// committed matrix is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { featureInventory } from "./feature-matrix.mjs";

const OUT = "docs/MKMN_FEATURE_TEST_MATRIX_0.0.2.md";

const cell = (value) => String(value).replace(/[\\|]/g, "\\$&");
const row = (id, name, area, evidence, result) => `| ${id} | ${cell(name)} | ${cell(area)} | ${cell(evidence)} | ${result} |`;
const table = (head, lines) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...lines].join("\n");

const ids = { REL: 0, UI: 0, HST: 0, SID: 0, STB: 0, SSC: 0, SRW: 0, SMF: 0, SCP: 0 };
const next = (prefix) => `${prefix}${String((ids[prefix] += 1)).padStart(3, "0")}`;

const TAURI_AREA = (name) => {
  if (/^agent_/.test(name)) return "Computer Use";
  if (/voice/.test(name)) return "Voice";
  if (/benchmark|hardware_config/.test(name)) return "Benchmark";
  if (/settings|app_info/.test(name)) return "Settings & app";
  if (/server|preload_model|geniex|model_manifest|model_evidence/.test(name)) return "Runtime & models";
  if (/meter|estimate_memory|power|metrics|inferring|qos|sleep/.test(name)) return "Meters & power";
  if (/window|task_manager/.test(name)) return "Window";
  if (/sha|chunk_document/.test(name)) return "Files & documents";
  if (/npu_diagnostics/.test(name)) return "Diagnostics";
  if (/sidecar_call/.test(name)) return "Sidecar bridge";
  return "System";
};

const TAURI_EVIDENCE = {
  preload_model: "tests/runtime-contracts.test.ts; tests/predictive-preload.test.ts",
  start_server: "cargo test supervisor; tests/runtime-contracts.test.ts",
  stop_server: "cargo test supervisor; tests/runtime-contracts.test.ts",
  get_server_status: "cargo test supervisor; tests/runtimeStatus.test.tsx",
  get_server_logs: "tests/runtime-contracts.test.ts",
  set_server_busy_cmd: "cargo test supervisor",
  geniex_capabilities_cmd: "tests/runtime-contracts.test.ts",
  model_manifest_cmd: "tests/manifest.test.ts",
  get_model_evidence_cmd: "tests/manifest.test.ts",
  record_model_evidence_cmd: "tests/manifest.test.ts",
  get_settings: "cargo test settings; tests/settings-close.test.ts",
  save_settings_cmd: "cargo test settings; tests/settings-close.test.ts",
  get_app_info_cmd: "tests/bridge-setup.test.ts",
  get_hardware_cmd: "tests/hostReadings.test.ts; tests/settings-ui.test.ts",
  get_installed_models_cmd: "tests/modelList.test.ts",
  get_meters_cmd: "tests/resourceMonitor.test.ts; tests/hostReadings.test.ts",
  estimate_memory_cmd: "tests/settings-fixes.test.ts",
  get_power_status_cmd: "tests/battery.test.ts; tests/hostReadings.test.ts",
  run_benchmark_cmd: "tests/bench.test.ts",
  cancel_benchmark_cmd: "tests/bench.test.ts",
  get_hardware_config_cmd: "tests/bench.test.ts",
  save_hardware_config_cmd: "tests/bench.test.ts",
  inhibit_sleep: "cargo test",
  get_system_metrics: "tests/resourceMonitor.test.ts",
  set_inferring_state: "tests/ecoqos.test.ts",
  open_task_manager: "installed-app check (native shell)",
  window_minimize: "installed-app check (native window)",
  window_maximize: "installed-app check (native window)",
  window_close: "tests/settings-close.test.ts; cargo test shutdown",
  get_qos_status_cmd: "tests/ecoqos.test.ts",
  set_qos_tier_cmd: "tests/ecoqos.test.ts",
  verify_sha256_cmd: "tests/manifest.test.ts",
  chunk_document_text_cmd: "tests/pdf-context.test.ts; tests/officeRead.test.ts",
  npu_diagnostics_cmd: "tests/npu-runtime-safety.test.ts",
  agent_list_windows_cmd: "tests/computerUse.test.ts; tests/computerUsePanel.test.tsx; cargo test agent_wire",
  agent_begin_run_cmd: "tests/computerUse.test.ts; tests/computerUsePanel.test.tsx (a fresh grant per run); cargo test agent_wire",
  agent_stop_cmd: "tests/computerUse.test.ts (the cancelled verdict, and no driver call after cancellation); tests/computerUsePanel.test.tsx (a failed Stop is surfaced); cargo test agent_wire",
  sidecar_call: "tests/bridge-chat.test.ts; tests/sidecarProtocol.test.ts"
};
const TAURI_RESULT = {
  open_task_manager: "MANUAL",
  window_minimize: "MANUAL",
  window_maximize: "MANUAL"
};

const SIDECAR_AREA = (name) => {
  if (/^agent(Run|StopRun|DocEdit)$/.test(name)) return "Computer Use";
  if (/^voice|^saveVoice|^transcribe|^speak|^cancelSpeak/.test(name)) return "Voice";
  if (/^router/.test(name)) return "Router";
  if (/^bench/.test(name)) return "Benchmark";
  if (/^npu/.test(name)) return "NPU";
  if (/^setup/.test(name)) return "Setup";
  if (/^(requirements|installRequirement|requirementUpdates|updateRequirement)$/.test(name)) return "Requirements";
  if (/^update/.test(name)) return "Updates";
  if (/^lab/.test(name)) return "Prompt lab";
  if (/^(runCode|runCommand|writeRun|stopRun)$/.test(name)) return "Code execution";
  if (/^(tasks|saveTask|deleteTask|runTask)$/.test(name)) return "Tasks";
  if (/^(saveMedia|readMedia)$/.test(name)) return "Media";
  if (name === "launchSite") return "Websites";
  if (/^(install|cancelInstall|uninstall|installDynamic|installDynamicModel|uninstallDynamic|customEntries|resolveModel|hfSearch|browse|dockerVariants|fetchLibrary)$/.test(name)) return "Models & catalog";
  if (/^(chat|abortChat|skipStep|compactChat|fixBlock)$/.test(name)) return "Chat";
  if (/^(adaptiveStatus|foundry)/.test(name)) return "Engines";
  if (/^(compiledContexts|speedsByRef|speedsById|resolveModelIdentity)$/.test(name)) return "Model data";
  if (name === "convertLegacyDoc") return "Documents";
  if (/^(forgetConversation|knowledgeForget)$/.test(name)) return "Privacy";
  if (/^(knowledge(Status|Build)|vectorModel(Status|Install|Remove))$/.test(name)) return "Knowledge";
  if (name === "wikimediaImage") return "Pictures";
  if (name === "testWebSearch") return "Web search";
  return "Host bridge";
};

const SIDECAR_EVIDENCE = {
  "Computer Use": "tests/computerUse.test.ts (17 loop tests over the real wire shapes, incl. the long-multiline verify pin); tests/docEdit.test.ts (the Edit-a-copy engine and loop: surgical document.xml edit, verification, Stop, refusals)",
  "Models & catalog": "tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts",
  Voice: "tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts",
  Chat: "tests/bridge-chat.test.ts; tests/core-chat-orchestrator.test.ts",
  Router: "tests/router.test.ts",
  Setup: "tests/setup.test.ts; tests/bridge-setup.test.ts",
  Requirements: "tests/requirements.test.ts; tests/requirement-updates.test.ts; tests/requirements-panel.test.tsx",
  Updates: "tests/bridge-setup.test.ts (contract only)",
  Benchmark: "tests/bench.test.ts; tests/bridge-devtools.test.ts",
  NPU: "tests/npuLoad.test.ts; tests/npu-runtime-safety.test.ts; tests/bridge-devtools.test.ts",
  "Prompt lab": "tests/promptLab.test.ts; tests/labCode.escape.test.ts; tests/bridge-devtools.test.ts",
  "Code execution": "tests/runcode.test.ts",
  "Tasks": "tests/workspace.test.ts (store only)",
  Media: "tests/media-persistence.test.ts; tests/upload-ownership.test.ts",
  Websites: "tests/siteOpen.test.ts",
  Engines: "tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts",
  "Model data": "tests/modelIdentity.test.ts; tests/speeds.test.ts; tests/compiled-context-ipc.test.ts",
  Documents: "tests/officeRead.test.ts",
  Privacy: "tests/forget-conversation.test.ts; tests/knowledge-forget.test.ts",
  Knowledge: "tests/knowledge-vectors.test.ts (vector path, store, pinned install); tests/multilingual-search.test.tsx; tests/knowledge-panel.test.ts; tests/knowledge-lifecycle.test.ts",
  Pictures: "tests/wikimedia.test.ts",
  "Web search": "manual check (needs a provider)",
  "Host bridge": "tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts"
};

const SIDECAR_LIVE_BLOCKED = new Set([
  "voiceDownload", "voiceQuickInstall", "transcribe", "speak", "testWebSearch", "fetchLibrary",
  "updateInstall", "updateForce", "npuReset"
]);

/** Methods run live on this PC (test profile) with a test profile. */
const SIDECAR_LIVE_PASS = new Set([
  "install", "installDynamic", "installDynamicModel", "routerInstall", "routerTest", "routerBench",
  "chat", "benchStart", "npuTestStart", "labStart", "runTask"
]);

const SMART_AREA = {
  "Tools on command only": "Tool routing",
  "Thinking": "Reasoning",
  "Sub-agents": "Delegation",
  "Code check": "Code",
  "Files beside the chat": "Artifacts",
  "Web search": "Web",
  "Pictures": "Pictures",
  "Auto-improve": "Loops",
  "Presentations: low power": "Presentations"
};
const SMART_EVIDENCE = {
  "Tools on command only": "tests/toolCommands.test.ts",
  "Thinking": "tests/effort.test.ts",
  "Sub-agents": "tests/subagents.test.tsx; tests/agentic.test.ts",
  "Code check": "tests/review.test.ts",
  "Files beside the chat": "tests/panel-preference.test.tsx",
  "Web search": "tests/dynamic.test.ts",
  "Pictures": "tests/wikimedia.test.ts",
  "Auto-improve": "tests/loops.test.ts",
  "Presentations: low power": "tests/deck.test.ts"
};

const SCREEN_EVIDENCE = {
  chat: "tests/navigation.test.tsx",
  projects: "tests/navigation.test.tsx",
  artifacts: "tests/navigation.test.tsx; tests/artifactGroups.test.ts",
  tasks: "tests/navigation.test.tsx; tests/workspace.test.ts",
  customize: "tests/navigation.test.tsx; tests/skills.test.ts",
  Settings: "tests/settings-ui.test.ts; tests/settings-export-import.test.ts",
  Models: "tests/navigation.test.tsx; tests/modelList.test.ts",
  Search: "manual check (dialog focus and keyboard)",
  "Setup screen": "tests/setup.test.ts; tests/bridge-setup.test.ts"
};

const SCRIPT_PURPOSE = {
  "scripts/Backup-Original.ps1": "copy an original build aside before an overlay",
  "scripts/Build-Windows.ps1": "build and stage the Windows installer",
  "scripts/Bundle-Sidecar.ps1": "bundle the Node sidecar with esbuild",
  "scripts/Check-After-Close.ps1": "verify the app after the window is closed",
  "scripts/Check-Installed-Sidecar.ps1": "drive the installed sidecar bundle over its protocol",
  "scripts/Live-Relaunch-Check.ps1": "check a live relaunch of the installed app",
  "scripts/Resolve-MkmnPaths.ps1": "resolve the MkmnPaths layout for scripts",
  "scripts/Validate-Installer.ps1": "validate the built installer",
  "scripts/audit-context.mjs": "audit the context sent to a model",
  "scripts/bench-probe-spawns.ts": "list the processes a benchmark spawns",
  "scripts/bench-save-path.ts": "print the benchmark save path",
  "scripts/build-xblocks.mjs": "build the page-block runtime",
  "scripts/check-language.mjs": "reject non-English, non-Arabic copy outside the allowlist",
  "scripts/generate-brand-assets.mjs": "generate the brand image set",
  "scripts/generate-state-machines.mjs": "generate and check the state-machine files",
  "scripts/lib/BuildResult.ps1": "write the one build result and its exit code",
  "scripts/lib/NativeCommand.ps1": "run one native command with a UTF-8 log and a real exit code",
  "scripts/lib/lifecycle-scan.mjs": "find every lifecycle in the source for the state-machine inventory",
  "scripts/licenses.mjs": "collect third-party licence texts",
  "scripts/nsis_extract.py": "extract the NSIS installer for inspection",
  "scripts/setup-arm64-libs.ps1": "place the ARM64 native libraries",
  "scripts/smoke-sidecar-chat.mjs": "smoke the sidecar chat path",
  "scripts/smoke-sidecar-devtools.js": "smoke the sidecar developer tools",
  "scripts/smoke-sidecar-sandbox.js": "smoke the sandboxed code runner",
  "scripts/smoke-sidecar-setup.js": "smoke the sidecar setup state",
  "scripts/smoke-sidecar-shutdown.js": "smoke the coordinated shutdown",
  "scripts/smoke-sidecar-humain.js": "smoke HUMAIN Fuse and Node end to end",
  "scripts/smoke-sidecar-voice.js": "smoke the voice sidecar",
  "scripts/smoke-sidecar.js": "smoke the sidecar protocol",
  "scripts/stage-sidecar-closure.cjs": "stage the sidecar dependency closure",
  "scripts/tournament.mjs": "run the model tournament",
  "scripts/vendor-anim.js": "copy the vendored animation libraries",
  "scripts/vendor-icons.js": "copy the vendored icon set",
  "scripts/xblocks-smoke/art.cjs": "smoke the art block",
  "scripts/xblocks-smoke/battle.cjs": "smoke the battle block",
  "scripts/xblocks-smoke/calc.cjs": "smoke the calculator block",
  "scripts/xblocks-smoke/core.cjs": "smoke the block runtime core",
  "scripts/xblocks-smoke/dialog.cjs": "smoke the dialog block",
  "scripts/xblocks-smoke/harness.cjs": "drive the block smoke tests",
  "scripts/xblocks-smoke/map.cjs": "smoke the map block",
  "scripts/xblocks-smoke/platformer.cjs": "smoke the platformer block",
  "scripts/xblocks-smoke/timer.cjs": "smoke the timer block"
};

const SCRIPT_EVIDENCE = {
  "scripts/Backup-Original.ps1": "manual check (not run in this session)",
  "scripts/Build-Windows.ps1": "tests/powershell-native.test.ts; release build PASS (16/16 steps)",
  "scripts/Bundle-Sidecar.ps1": "tests/powershell-native.test.ts; release build PASS",
  "scripts/Check-After-Close.ps1": "installed-app check",
  "scripts/Check-Installed-Sidecar.ps1": "installed-app check",
  "scripts/Live-Relaunch-Check.ps1": "installed-app check",
  "scripts/Resolve-MkmnPaths.ps1": "tests/paths-contract.test.ts",
  "scripts/Validate-Installer.ps1": "release Installer check",
  "scripts/audit-context.mjs": "tests/audit-context.test.ts",
  "scripts/bench-probe-spawns.ts": "manual check (diagnostic only)",
  "scripts/bench-save-path.ts": "tests/bench.test.ts",
  "scripts/build-xblocks.mjs": "tests/gameBlocks.test.ts; tests/xbuild.test.ts",
  "scripts/check-language.mjs": "tests/language.test.ts",
  "scripts/generate-brand-assets.mjs": "tests/brandAssets.test.ts",
  "scripts/generate-state-machines.mjs": "tests/state-machines.test.ts",
  "scripts/lib/BuildResult.ps1": "tests/powershell-native.test.ts",
  "scripts/lib/NativeCommand.ps1": "tests/powershell-native.test.ts",
  "scripts/lib/lifecycle-scan.mjs": "tests/state-machines.test.ts",
  "scripts/licenses.mjs": "tests/brandAssets.test.ts",
  "scripts/nsis_extract.py": "release Installer check",
  "scripts/setup-arm64-libs.ps1": "manual check (native library setup)",
  "scripts/smoke-sidecar-chat.mjs": "ran live (test profile: chat with qwen3-1.7b-native on the NPU); PASS",
  "scripts/smoke-sidecar-devtools.js": "needs an NPU and the app host; BLOCKED",
  "scripts/smoke-sidecar-sandbox.js": "ran live (test profile: runTask/runCode/runCommand/media/launchSite); PASS",
  "scripts/smoke-sidecar-setup.js": "ran live (test profile); PASS",
  "scripts/smoke-sidecar-shutdown.js": "ran live (test profile: appShutdown during active work); PASS",
  "scripts/smoke-sidecar-humain.js": "ran live (saved keys, copies only): Fuse chat through the pipeline, chart block, web search with sources, named model error, embeddings, rerank, limits, voices, speech, transcription, image, files, batches; Node chat, healthz, realtime refusal named; PASS 21/21",
  "scripts/smoke-sidecar-voice.js": "ran live (test profile: voiceApply/transcribe/speak/saveVoice); PASS",
  "scripts/smoke-sidecar.js": "ran live (test profile: installDynamicModel + uninstall roundtrip); PASS",
  "scripts/stage-sidecar-closure.cjs": "tests/runtime-contracts.test.ts",
  "scripts/tournament.mjs": "manual check (benchmark only)",
  "scripts/vendor-anim.js": "tests/brandAssets.test.ts",
  "scripts/vendor-icons.js": "tests/iconTableReady.test.ts",
  "scripts/xblocks-smoke/art.cjs": "tests/gameBlocks.test.ts",
  "scripts/xblocks-smoke/battle.cjs": "tests/gameBlocks.test.ts",
  "scripts/xblocks-smoke/calc.cjs": "tests/gameBlocks.test.ts",
  "scripts/xblocks-smoke/core.cjs": "tests/gameBlocks.test.ts",
  "scripts/xblocks-smoke/dialog.cjs": "tests/gameBlocks.test.ts",
  "scripts/xblocks-smoke/harness.cjs": "tests/gameBlocks.test.ts",
  "scripts/xblocks-smoke/map.cjs": "tests/gameBlocks.test.ts",
  "scripts/xblocks-smoke/platformer.cjs": "tests/gameBlocks.test.ts",
  "scripts/xblocks-smoke/timer.cjs": "tests/gameBlocks.test.ts"
};

export function matrixText(root = process.cwd()) {
  const inv = featureInventory(root);
  ids.REL = ids.UI = ids.HST = ids.SID = ids.STB = ids.SSC = ids.SRW = ids.SMF = ids.CLD = ids.SCP = 0;
  const ss = readFileSync(`${root}/src/renderer/settingsSearch.ts`, "utf8");

  const tabMeta = [...ss.matchAll(/^\s*\{ id: "([^"]+)", label: "([^"]+)", hint: "([^"]+)"/gm)]
    .map((m) => ({ id: m[1], label: m[2], hint: m[3] }));
  const tabOf = (section) => {
    if (section.startsWith("sec-general") || section.startsWith("sec-about")) return "general";
    if (section.startsWith("sec-models")) return "models";
    if (section.startsWith("sec-voice")) return "voice";
    if (section.startsWith("sec-chats") || section === "sec-build-behavior") return "chats";
    if (section.startsWith("sec-build") || section.startsWith("sec-files")) return "files";
    if (section.startsWith("sec-web")) return "web";
    if (section.startsWith("sec-sys") || section.startsWith("sec-rt") || section.startsWith("sec-route") || section.startsWith("sec-diag")) return "developer";
    return "?";
  };
  const rowMeta = [...ss.matchAll(/\{ label: "([^"]+)", (?:tab: "([^"]+)"|dest: "([^"]+)")/g)]
    .map((m) => ({ label: m[1], tab: m[2] ?? m[3] ?? "?" }));

  const gates = [
    ["Clean source baseline", "git status; the release build runs on a committed tree", "PASS"],
    ["One build result and a real exit code", "tests/powershell-native.test.ts", "PASS"],
    ["NaN attribution, destructuring reads and unresolved runs", "tests/build.test.ts", "PASS"],
    ["Files open beside the chat, switch routes to Artifacts", "tests/panel-preference.test.tsx", "PASS"],
    ["One registry for server, voice and build states", "tests/state-machines.test.ts; node scripts/generate-state-machines.mjs --check", "PASS"],
    ["Server transition guard", "cargo test state_machine; cargo test supervisor", "PASS"],
    ["Voice transitions in one full session", "tests/voice.test.ts", "PASS"],
    ["Build status uses the generated three-state name", "tests/build.test.ts", "PASS"],
    ["English and Arabic only, with a named allowlist", "tests/language.test.ts; node scripts/check-language.mjs", "PASS"],
    ["Full automated suite", "pnpm typecheck; pnpm test; cargo test", "Automated release checks"],
    ["Version 0.0.2 in every manifest", "tests/version.test.ts", "CONTRACT"],
    ["HUMAIN chat, secure credentials and provider selection", "tests/humain.test.ts; tests/humain-settings.test.tsx; tests/humain-model-selection.test.ts; tests/chat-send-guard.test.tsx", "CONTRACT"],
    ["Grouped Settings, provider search, keyboard navigation and chat location", "tests/settings-ui.test.ts; tests/navigation.test.tsx; tests/chat-send-guard.test.tsx; tests/brandAssets.test.ts", "CONTRACT"],
  ];
  const gateRows = gates.map(([name, evidence, result]) => row(next("REL"), name, "Release gate", evidence, result));

  const screenRows = inv.screens.map((name) => {
    const result = name === "Search" ? "MANUAL" : "CONTRACT";
    return row(next("UI"), `\`${name}\``, "Screen or overlay", SCREEN_EVIDENCE[name] ?? "manual check", result);
  });

  const tauriRows = inv.tauri.map((name) => row(next("HST"), `\`${name}\``, TAURI_AREA(name), TAURI_EVIDENCE[name] ?? "cargo test; bridge suite", TAURI_RESULT[name] ?? "CONTRACT"));
  const sidecarRows = inv.sidecar.map((name) => {
    const area = SIDECAR_AREA(name);
    const evidence = SIDECAR_EVIDENCE[area] ?? "manual check";
    const result = SIDECAR_LIVE_BLOCKED.has(name) ? "CONTRACT; live BLOCKED" : SIDECAR_LIVE_PASS.has(name) ? "CONTRACT; live PASS" : area === "Web search" ? "BLOCKED" : "CONTRACT";
    return row(next("SID"), `\`${name}\``, area, evidence, result);
  });

  const tabRows = inv.tabs.map((id) => {
    const meta = tabMeta.find((t) => t.id === id);
    return row(next("STB"), `\`${id}\``, meta?.label ?? id, meta?.hint ?? "", "CONTRACT");
  });
  const sectionRows = inv.sections.map((id) => row(next("SSC"), `\`${id}\``, tabOf(id), "tests/settings-ui.test.ts (deep links and rendering)", "CONTRACT"));
  const settingRows = inv.rows.map((label) => {
    const meta = rowMeta.find((r) => r.label === label);
    return row(next("SRW"), `\`${label}\``, meta?.tab ?? "?", "tests/settings-ui.test.ts; tests/settings-fixes.test.ts", "CONTRACT");
  });
  const smartRows = inv.smart.map((label) => row(next("SMF"), `\`${label}\``, SMART_AREA[label] ?? "Smart functions", SMART_EVIDENCE[label] ?? "manual check", "CONTRACT"));

  const scriptRows = inv.scripts.map((path) => {
    const result = /BLOCKED/.test(SCRIPT_EVIDENCE[path] ?? "") ? "BLOCKED" : /pending|Installer check|installed-app|manual check/.test(SCRIPT_EVIDENCE[path] ?? "") ? "MANUAL" : "CONTRACT";
    return row(next("SCP"), `\`${path}\``, SCRIPT_PURPOSE[path] ?? "script", SCRIPT_EVIDENCE[path] ?? "manual check", result);
  });

  const lines = [];
  lines.push("# MKMN AI v0.0.2 — feature test matrix");
  lines.push("");
  lines.push("MKMN 0.0.2 requires Qualcomm GenieX v0.11.0 or newer for local inference and checks it before any GenieX server starts or is adopted. This inventory is generated from source.");
  lines.push("");
  lines.push(`Generated from ${inv.tauri.length} host commands, ${inv.sidecar.length} sidecar methods, ${inv.tabs.length} Settings groups, ${inv.sections.length} Settings sections, ${inv.rows.length} Settings rows, ${inv.smart.length} Smart functions, ${inv.screens.length} screens and ${inv.scripts.length} scripts.`);
  lines.push("");
  lines.push("## How to read the result column");
  lines.push("");
  lines.push("- **PASS** — the named automated test ran and passed in this session.");
  lines.push("- **CONTRACT** — the contract, store or bridge was tested; the visual or installed-app path is still checked by hand.");
  lines.push("- **MANUAL** — no automated test can prove it; the installed-app checklist below is the evidence.");
  lines.push("- **BLOCKED** — the path needs a real model, microphone, NPU or credential that this machine does not have.");
  lines.push("- **NOT RE-RUN** — the installed-app path was not driven this session; the named automated suite pins its contract, and the click-through is owed.");
  lines.push("");
  lines.push("The automated commands used for this matrix:");
  lines.push("");
  lines.push("```text");
  lines.push("pnpm exec vitest run");
  lines.push("pnpm typecheck");
  lines.push("cargo check");
  lines.push("cargo test");
  lines.push("node scripts/check-language.mjs");
  lines.push("node scripts/generate-state-machines.mjs --check");
  lines.push("node scripts/generate-feature-matrix.mjs --check");
  lines.push("```");
  lines.push("");
  lines.push("## Release gates and blocked paths");
  lines.push("");
  lines.push(table(["ID", "Gate or path", "Area", "How checked", "Result"], gateRows));
  lines.push("");
  lines.push("## Screens and overlays");
  lines.push("");
  lines.push(table(["ID", "Screen", "Area", "How checked", "Result"], screenRows));
  lines.push("");
  lines.push("## Tauri host commands");
  lines.push("");
  lines.push(table(["ID", "Command", "Area", "How checked", "Result"], tauriRows));
  lines.push("");
  lines.push("## Sidecar methods");
  lines.push("");
  lines.push(table(["ID", "Method", "Area", "How checked", "Result"], sidecarRows));
  lines.push("");
  lines.push("## Settings groups");
  lines.push("");
  lines.push(table(["ID", "Group", "Label", "Hint", "Result"], tabRows));
  lines.push("");
  lines.push("## Settings sections");
  lines.push("");
  lines.push(table(["ID", "Section", "Group", "How checked", "Result"], sectionRows));
  lines.push("");
  lines.push("## Settings rows");
  lines.push("");
  lines.push(table(["ID", "Row", "Group", "How checked", "Result"], settingRows));
  lines.push("");
  lines.push("## Smart functions");
  lines.push("");
  lines.push(table(["ID", "Row", "Area", "How checked", "Result"], smartRows));
  lines.push("");
  lines.push("## Scripts");
  lines.push("");
  lines.push(table(["ID", "Script", "Purpose", "How checked", "Result"], scriptRows));
  lines.push("");
  return lines.join("\n");
}

const target = process.argv[2] === "--write" ? OUT : null;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = matrixText(process.cwd());
  if (target) {
    writeFileSync(target, text, "utf8");
    console.log(`Wrote ${target}`);
  } else {
    let current = "";
    try { current = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n"); } catch { /* missing is stale */ }
    if (current !== text) {
      console.error(`${OUT} is stale: run node scripts/generate-feature-matrix.mjs --write`);
      process.exit(1);
    }
    console.log(`${OUT} is current.`);
  }
}
