# MKMN AI v0.0.2 — feature test matrix

MKMN 0.0.2 requires Qualcomm GenieX v0.11.0 or newer for local inference and checks it before any GenieX server starts or is adopted. This inventory is generated from source.

Generated from 40 host commands, 133 sidecar methods, 0 Settings groups, 51 Settings sections, 107 Settings rows, 4 Smart functions, 9 screens and 45 scripts.

## How to read the result column

- **PASS** — the named automated test ran and passed in this session.
- **CONTRACT** — the contract, store or bridge was tested; the visual or installed-app path is still checked by hand.
- **MANUAL** — no automated test can prove it; the installed-app checklist below is the evidence.
- **BLOCKED** — the path needs a real model, microphone, NPU or credential that this machine does not have.
- **NOT RE-RUN** — the installed-app path was not driven this session; the named automated suite pins its contract, and the click-through is owed.

The automated commands used for this matrix:

```text
pnpm exec vitest run
pnpm typecheck
cargo check
cargo test
node scripts/check-language.mjs
node scripts/generate-state-machines.mjs --check
node scripts/generate-feature-matrix.mjs --check
```

## Release gates and blocked paths

| ID | Gate or path | Area | How checked | Result |
|---|---|---|---|---|
| REL001 | Clean source baseline | Release gate | git status; the release build runs on a committed tree | PASS |
| REL002 | One build result and a real exit code | Release gate | tests/powershell-native.test.ts | PASS |
| REL003 | NaN attribution, destructuring reads and unresolved runs | Release gate | tests/build.test.ts | PASS |
| REL004 | Files open beside the chat, switch routes to Artifacts | Release gate | tests/panel-preference.test.tsx | PASS |
| REL005 | One registry for server, voice and build states | Release gate | tests/state-machines.test.ts; node scripts/generate-state-machines.mjs --check | PASS |
| REL006 | Server transition guard | Release gate | cargo test state_machine; cargo test supervisor | PASS |
| REL007 | Voice transitions in one full session | Release gate | tests/voice.test.ts | PASS |
| REL008 | Build status uses the generated three-state name | Release gate | tests/build.test.ts | PASS |
| REL009 | English and Arabic only, with a named allowlist | Release gate | tests/language.test.ts; node scripts/check-language.mjs | PASS |
| REL010 | Full automated suite | Release gate | pnpm typecheck; pnpm test; cargo test | Automated release checks |
| REL011 | Version 0.0.2 in every manifest | Release gate | tests/version.test.ts | CONTRACT |
| REL012 | HUMAIN chat, secure credentials and provider selection | Release gate | tests/humain.test.ts; tests/humain-settings.test.tsx; tests/humain-model-selection.test.ts; tests/chat-send-guard.test.tsx | CONTRACT |
| REL013 | Grouped Settings, provider search, keyboard navigation and chat location | Release gate | tests/settings-ui.test.ts; tests/navigation.test.tsx; tests/chat-send-guard.test.tsx; tests/brandAssets.test.ts | CONTRACT |

## Screens and overlays

| ID | Screen | Area | How checked | Result |
|---|---|---|---|---|
| UI001 | `chat` | Screen or overlay | tests/navigation.test.tsx | CONTRACT |
| UI002 | `projects` | Screen or overlay | tests/navigation.test.tsx | CONTRACT |
| UI003 | `artifacts` | Screen or overlay | tests/navigation.test.tsx; tests/artifactGroups.test.ts | CONTRACT |
| UI004 | `tasks` | Screen or overlay | tests/navigation.test.tsx; tests/workspace.test.ts | CONTRACT |
| UI005 | `customize` | Screen or overlay | tests/navigation.test.tsx; tests/skills.test.ts | CONTRACT |
| UI006 | `Settings` | Screen or overlay | tests/settings-ui.test.ts; tests/settings-export-import.test.ts | CONTRACT |
| UI007 | `Models` | Screen or overlay | tests/navigation.test.tsx; tests/modelList.test.ts | CONTRACT |
| UI008 | `Search` | Screen or overlay | manual check (dialog focus and keyboard) | MANUAL |
| UI009 | `Setup screen` | Screen or overlay | tests/setup.test.ts; tests/bridge-setup.test.ts | CONTRACT |

## Tauri host commands

| ID | Command | Area | How checked | Result |
|---|---|---|---|---|
| HST001 | `preload_model` | Runtime & models | tests/runtime-contracts.test.ts; tests/predictive-preload.test.ts | CONTRACT |
| HST002 | `start_server` | Runtime & models | cargo test supervisor; tests/runtime-contracts.test.ts | CONTRACT |
| HST003 | `stop_server` | Runtime & models | cargo test supervisor; tests/runtime-contracts.test.ts | CONTRACT |
| HST004 | `get_server_status` | Runtime & models | cargo test supervisor; tests/runtimeStatus.test.tsx | CONTRACT |
| HST005 | `get_server_logs` | Runtime & models | tests/runtime-contracts.test.ts | CONTRACT |
| HST006 | `set_server_busy_cmd` | Runtime & models | cargo test supervisor | CONTRACT |
| HST007 | `geniex_capabilities_cmd` | Runtime & models | tests/runtime-contracts.test.ts | CONTRACT |
| HST008 | `model_manifest_cmd` | Runtime & models | tests/manifest.test.ts | CONTRACT |
| HST009 | `get_model_evidence_cmd` | Runtime & models | tests/manifest.test.ts | CONTRACT |
| HST010 | `record_model_evidence_cmd` | Runtime & models | tests/manifest.test.ts | CONTRACT |
| HST011 | `get_settings` | Settings & app | cargo test settings; tests/settings-close.test.ts | CONTRACT |
| HST012 | `save_settings_cmd` | Settings & app | cargo test settings; tests/settings-close.test.ts | CONTRACT |
| HST013 | `get_settings_repair_notice` | Settings & app | cargo test; bridge suite | CONTRACT |
| HST014 | `get_app_info_cmd` | Settings & app | tests/bridge-setup.test.ts | CONTRACT |
| HST015 | `get_hardware_cmd` | System | tests/hostReadings.test.ts; tests/settings-ui.test.ts | CONTRACT |
| HST016 | `get_installed_models_cmd` | System | tests/modelList.test.ts | CONTRACT |
| HST017 | `get_meters_cmd` | Meters & power | tests/resourceMonitor.test.ts; tests/hostReadings.test.ts | CONTRACT |
| HST018 | `estimate_memory_cmd` | Meters & power | tests/settings-fixes.test.ts | CONTRACT |
| HST019 | `get_power_status_cmd` | Meters & power | tests/battery.test.ts; tests/hostReadings.test.ts | CONTRACT |
| HST020 | `run_benchmark_cmd` | Benchmark | tests/bench.test.ts | CONTRACT |
| HST021 | `cancel_benchmark_cmd` | Benchmark | tests/bench.test.ts | CONTRACT |
| HST022 | `get_hardware_config_cmd` | Benchmark | tests/bench.test.ts | CONTRACT |
| HST023 | `save_hardware_config_cmd` | Benchmark | tests/bench.test.ts | CONTRACT |
| HST024 | `inhibit_sleep` | Meters & power | cargo test | CONTRACT |
| HST025 | `get_system_metrics` | Meters & power | tests/resourceMonitor.test.ts | CONTRACT |
| HST026 | `set_inferring_state` | Meters & power | tests/ecoqos.test.ts | CONTRACT |
| HST027 | `open_task_manager` | Window | installed-app check (native shell) | MANUAL |
| HST028 | `window_minimize` | Window | installed-app check (native window) | MANUAL |
| HST029 | `window_maximize` | Window | installed-app check (native window) | MANUAL |
| HST030 | `window_close` | Window | tests/settings-close.test.ts; cargo test shutdown | CONTRACT |
| HST031 | `get_qos_status_cmd` | Meters & power | tests/ecoqos.test.ts | CONTRACT |
| HST032 | `set_qos_tier_cmd` | Meters & power | tests/ecoqos.test.ts | CONTRACT |
| HST033 | `verify_sha256_cmd` | Files & documents | tests/manifest.test.ts | CONTRACT |
| HST034 | `chunk_document_text_cmd` | Files & documents | tests/pdf-context.test.ts; tests/officeRead.test.ts | CONTRACT |
| HST035 | `ocr_page_cmd` | System | cargo test; bridge suite | CONTRACT |
| HST036 | `npu_diagnostics_cmd` | Diagnostics | tests/npu-runtime-safety.test.ts | CONTRACT |
| HST037 | `sidecar_call` | Sidecar bridge | tests/bridge-chat.test.ts; tests/sidecarProtocol.test.ts | CONTRACT |
| HST038 | `agent_list_windows_cmd` | Computer Use | tests/computerUse.test.ts; tests/computerUsePanel.test.tsx; cargo test agent_wire | CONTRACT |
| HST039 | `agent_begin_run_cmd` | Computer Use | tests/computerUse.test.ts; tests/computerUsePanel.test.tsx (a fresh grant per run); cargo test agent_wire | CONTRACT |
| HST040 | `agent_stop_cmd` | Computer Use | tests/computerUse.test.ts (the cancelled verdict, and no driver call after cancellation); tests/computerUsePanel.test.tsx (a failed Stop is surfaced); cargo test agent_wire | CONTRACT |

## Sidecar methods

| ID | Method | Area | How checked | Result |
|---|---|---|---|---|
| SID001 | `ping` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID002 | `hfSearch` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT |
| SID003 | `browse` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT |
| SID004 | `dockerVariants` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT |
| SID005 | `resolveModel` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT |
| SID006 | `fetchLibrary` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT; live BLOCKED |
| SID007 | `convertLegacyDoc` | Documents | tests/officeRead.test.ts | CONTRACT |
| SID008 | `pickFolder` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID009 | `customEntries` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT |
| SID010 | `install` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT; live PASS |
| SID011 | `cancelInstall` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT |
| SID012 | `uninstall` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT |
| SID013 | `geniexSetType` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID014 | `geniexConfigList` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID015 | `geniexClean` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID016 | `geniexPullLocal` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID017 | `installDynamic` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT; live PASS |
| SID018 | `installDynamicModel` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT; live PASS |
| SID019 | `uninstallDynamic` | Models & catalog | tests/providers.test.ts; tests/modelList.test.ts; tests/removal-safety.test.ts | CONTRACT |
| SID020 | `voiceModels` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT |
| SID021 | `voiceStatus` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT |
| SID022 | `voiceDownload` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT; live BLOCKED |
| SID023 | `voiceCancelDownload` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT |
| SID024 | `voiceRemove` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT |
| SID025 | `voiceApply` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT |
| SID026 | `transcribe` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT; live BLOCKED |
| SID027 | `voiceNeeds` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT |
| SID028 | `voiceQuickInstall` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT; live BLOCKED |
| SID029 | `speak` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT; live BLOCKED |
| SID030 | `cancelSpeak` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT |
| SID031 | `saveVoice` | Voice | tests/voice.test.ts; tests/bridge-voice.test.ts; tests/voiceSpeech.test.ts | CONTRACT |
| SID032 | `resolveModelIdentity` | Model data | tests/modelIdentity.test.ts; tests/speeds.test.ts; tests/compiled-context-ipc.test.ts | CONTRACT |
| SID033 | `speedsByRef` | Model data | tests/modelIdentity.test.ts; tests/speeds.test.ts; tests/compiled-context-ipc.test.ts | CONTRACT |
| SID034 | `speedsById` | Model data | tests/modelIdentity.test.ts; tests/speeds.test.ts; tests/compiled-context-ipc.test.ts | CONTRACT |
| SID035 | `compiledContexts` | Model data | tests/modelIdentity.test.ts; tests/speeds.test.ts; tests/compiled-context-ipc.test.ts | CONTRACT |
| SID036 | `startGeniexModel` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID037 | `preloadGeniexModel` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID038 | `restartGeniexModel` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID039 | `benchmarkGeniexModel` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID040 | `chat` | Chat | tests/bridge-chat.test.ts; tests/core-chat-orchestrator.test.ts | CONTRACT; live PASS |
| SID041 | `abortChat` | Chat | tests/bridge-chat.test.ts; tests/core-chat-orchestrator.test.ts | CONTRACT |
| SID042 | `routerFileKind` | Router | tests/router.test.ts | CONTRACT |
| SID043 | `skipStep` | Chat | tests/bridge-chat.test.ts; tests/core-chat-orchestrator.test.ts | CONTRACT |
| SID044 | `routerStatus` | Router | tests/router.test.ts | CONTRACT |
| SID045 | `routerCandidates` | Router | tests/router.test.ts | CONTRACT |
| SID046 | `routerBench` | Router | tests/router.test.ts | CONTRACT; live PASS |
| SID047 | `routerInstall` | Router | tests/router.test.ts | CONTRACT; live PASS |
| SID048 | `routerTest` | Router | tests/router.test.ts | CONTRACT; live PASS |
| SID049 | `compactChat` | Chat | tests/bridge-chat.test.ts; tests/core-chat-orchestrator.test.ts | CONTRACT |
| SID050 | `fixBlock` | Chat | tests/bridge-chat.test.ts; tests/core-chat-orchestrator.test.ts | CONTRACT |
| SID051 | `setupState` | Setup | tests/setup.test.ts; tests/bridge-setup.test.ts | CONTRACT |
| SID052 | `setupConfirm` | Setup | tests/setup.test.ts; tests/bridge-setup.test.ts | CONTRACT |
| SID053 | `setupDecline` | Setup | tests/setup.test.ts; tests/bridge-setup.test.ts | CONTRACT |
| SID054 | `setupDismiss` | Setup | tests/setup.test.ts; tests/bridge-setup.test.ts | CONTRACT |
| SID055 | `setupSkip` | Setup | tests/setup.test.ts; tests/bridge-setup.test.ts | CONTRACT |
| SID056 | `setupRetry` | Setup | tests/setup.test.ts; tests/bridge-setup.test.ts | CONTRACT |
| SID057 | `setupRunUnsigned` | Setup | tests/setup.test.ts; tests/bridge-setup.test.ts | CONTRACT |
| SID058 | `updateState` | Updates | tests/bridge-setup.test.ts (contract only) | CONTRACT |
| SID059 | `updateCheck` | Updates | tests/bridge-setup.test.ts (contract only) | CONTRACT |
| SID060 | `updateInstall` | Updates | tests/bridge-setup.test.ts (contract only) | CONTRACT; live BLOCKED |
| SID061 | `updateForce` | Updates | tests/bridge-setup.test.ts (contract only) | CONTRACT; live BLOCKED |
| SID062 | `benchRoster` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID063 | `benchState` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID064 | `benchResults` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID065 | `benchExport` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID066 | `benchReveal` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID067 | `openEditedCopy` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID068 | `benchStart` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT; live PASS |
| SID069 | `benchStop` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID070 | `benchImportResults` | Benchmark | tests/bench.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID071 | `adaptiveStatus` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID072 | `foundryStatus` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID073 | `foundryEntries` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID074 | `foundryAdmin` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID075 | `foundryConfigSet` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID076 | `foundryConfigReset` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID077 | `foundryCacheSet` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID078 | `foundryCacheRemove` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID079 | `foundryServer` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID080 | `foundryLogs` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID081 | `foundryModelInfo` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID082 | `foundryModelRegister` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID083 | `foundryModelUnregister` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID084 | `foundryModelLoad` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID085 | `foundryModelUnload` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID086 | `foundryTranscribe` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID087 | `requirements` | Requirements | tests/requirements.test.ts; tests/requirement-updates.test.ts; tests/requirements-panel.test.tsx | CONTRACT |
| SID088 | `installRequirement` | Requirements | tests/requirements.test.ts; tests/requirement-updates.test.ts; tests/requirements-panel.test.tsx | CONTRACT |
| SID089 | `requirementUpdates` | Requirements | tests/requirements.test.ts; tests/requirement-updates.test.ts; tests/requirements-panel.test.tsx | CONTRACT |
| SID090 | `updateRequirement` | Requirements | tests/requirements.test.ts; tests/requirement-updates.test.ts; tests/requirements-panel.test.tsx | CONTRACT |
| SID091 | `foundryReport` | Engines | tests/foundry.test.ts; tests/foundryAdmin.test.ts; tests/adaptiveCompute.test.ts | CONTRACT |
| SID092 | `npuTestState` | NPU | tests/npuLoad.test.ts; tests/npu-runtime-safety.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID093 | `npuTestRoster` | NPU | tests/npuLoad.test.ts; tests/npu-runtime-safety.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID094 | `npuTestStart` | NPU | tests/npuLoad.test.ts; tests/npu-runtime-safety.test.ts; tests/bridge-devtools.test.ts | CONTRACT; live PASS |
| SID095 | `npuTestStop` | NPU | tests/npuLoad.test.ts; tests/npu-runtime-safety.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID096 | `npuReset` | NPU | tests/npuLoad.test.ts; tests/npu-runtime-safety.test.ts; tests/bridge-devtools.test.ts | CONTRACT; live BLOCKED |
| SID097 | `npuResetStatus` | NPU | tests/npuLoad.test.ts; tests/npu-runtime-safety.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID098 | `batteryRead` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID099 | `labStart` | Prompt lab | tests/promptLab.test.ts; tests/labCode.escape.test.ts; tests/bridge-devtools.test.ts | CONTRACT; live PASS |
| SID100 | `labStop` | Prompt lab | tests/promptLab.test.ts; tests/labCode.escape.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID101 | `labState` | Prompt lab | tests/promptLab.test.ts; tests/labCode.escape.test.ts; tests/bridge-devtools.test.ts | CONTRACT |
| SID102 | `unknownModelCheckState` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID103 | `runCode` | Code execution | tests/runcode.test.ts | CONTRACT |
| SID104 | `runCommand` | Code execution | tests/runcode.test.ts | CONTRACT |
| SID105 | `writeRun` | Code execution | tests/runcode.test.ts | CONTRACT |
| SID106 | `stopRun` | Code execution | tests/runcode.test.ts | CONTRACT |
| SID107 | `agentRun` | Computer Use | tests/computerUse.test.ts (17 loop tests over the real wire shapes, incl. the long-multiline verify pin); tests/docEdit.test.ts (the Edit-a-copy engine and loop: surgical document.xml edit, verification, Stop, refusals) | CONTRACT |
| SID108 | `agentStopRun` | Computer Use | tests/computerUse.test.ts (17 loop tests over the real wire shapes, incl. the long-multiline verify pin); tests/docEdit.test.ts (the Edit-a-copy engine and loop: surgical document.xml edit, verification, Stop, refusals) | CONTRACT |
| SID109 | `agentDocEditDecide` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID110 | `agentDocEdit` | Computer Use | tests/computerUse.test.ts (17 loop tests over the real wire shapes, incl. the long-multiline verify pin); tests/docEdit.test.ts (the Edit-a-copy engine and loop: surgical document.xml edit, verification, Stop, refusals) | CONTRACT |
| SID111 | `appShutdown` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID112 | `launchSite` | Websites | tests/siteOpen.test.ts | CONTRACT |
| SID113 | `knowledgeStatus` | Knowledge | tests/knowledge-vectors.test.ts (vector path, store, pinned install); tests/multilingual-search.test.tsx; tests/knowledge-panel.test.ts; tests/knowledge-lifecycle.test.ts | CONTRACT |
| SID114 | `knowledgeForget` | Privacy | tests/forget-conversation.test.ts; tests/knowledge-forget.test.ts | CONTRACT |
| SID115 | `knowledgeBuild` | Knowledge | tests/knowledge-vectors.test.ts (vector path, store, pinned install); tests/multilingual-search.test.tsx; tests/knowledge-panel.test.ts; tests/knowledge-lifecycle.test.ts | CONTRACT |
| SID116 | `vectorModelStatus` | Knowledge | tests/knowledge-vectors.test.ts (vector path, store, pinned install); tests/multilingual-search.test.tsx; tests/knowledge-panel.test.ts; tests/knowledge-lifecycle.test.ts | CONTRACT |
| SID117 | `vectorModelInstall` | Knowledge | tests/knowledge-vectors.test.ts (vector path, store, pinned install); tests/multilingual-search.test.tsx; tests/knowledge-panel.test.ts; tests/knowledge-lifecycle.test.ts | CONTRACT |
| SID118 | `vectorModelRemove` | Knowledge | tests/knowledge-vectors.test.ts (vector path, store, pinned install); tests/multilingual-search.test.tsx; tests/knowledge-panel.test.ts; tests/knowledge-lifecycle.test.ts | CONTRACT |
| SID119 | `saveMedia` | Media | tests/media-persistence.test.ts; tests/upload-ownership.test.ts | CONTRACT |
| SID120 | `readMedia` | Media | tests/media-persistence.test.ts; tests/upload-ownership.test.ts | CONTRACT |
| SID121 | `tasks` | Tasks | tests/workspace.test.ts (store only) | CONTRACT |
| SID122 | `saveTask` | Tasks | tests/workspace.test.ts (store only) | CONTRACT |
| SID123 | `forgetConversation` | Privacy | tests/forget-conversation.test.ts; tests/knowledge-forget.test.ts | CONTRACT |
| SID124 | `deleteTask` | Tasks | tests/workspace.test.ts (store only) | CONTRACT |
| SID125 | `runTask` | Tasks | tests/workspace.test.ts (store only) | CONTRACT; live PASS |
| SID126 | `humainKeySaved` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID127 | `humainSaveKey` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID128 | `humainModels` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID129 | `humainRealtimeOpen` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID130 | `humainRealtimeEvents` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID131 | `humainRealtimeSend` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID132 | `humainRealtimeClose` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |
| SID133 | `humainOperation` | Host bridge | tests/sidecarProtocol.test.ts; tests/runtime-contracts.test.ts | CONTRACT |

## Settings groups

| ID | Group | Label | Hint | Result |
|---|---|---|---|---|

## Settings sections

| ID | Section | Group | How checked | Result |
|---|---|---|---|---|
| SSC001 | `sec-general-appearance` | general | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC002 | `sec-general-close` | general | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC003 | `sec-about-mkmn` | general | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC004 | `sec-about-update` | general | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC005 | `sec-about-help` | general | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC006 | `sec-library-options` | ? | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC007 | `sec-models-summary` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC008 | `sec-models-compute` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC009 | `sec-models-retention` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC010 | `sec-models-memory` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC011 | `sec-models-plan` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC012 | `sec-models-context` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC013 | `sec-models-power` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC014 | `sec-models-speculative` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC015 | `sec-models-offload` | models | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC016 | `sec-voice-mic` | voice | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC017 | `sec-voice-dictation` | voice | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC018 | `sec-voice-tts` | voice | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC019 | `sec-voice-chat` | voice | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC020 | `sec-voice-calibration` | voice | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC021 | `sec-chats-location` | chats | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC022 | `sec-chats-thinking` | chats | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC023 | `sec-chats-tools` | chats | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC024 | `sec-chats-agents` | chats | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC025 | `sec-chats-long` | chats | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC026 | `sec-build-behavior` | chats | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC027 | `sec-files-panels` | files | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC028 | `sec-files-multilingual` | files | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC029 | `sec-build-check` | files | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC030 | `sec-build-improve` | files | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC031 | `sec-build-writers` | files | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC032 | `sec-sys-devtools` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC033 | `sec-rt-requirements` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC034 | `sec-rt-genies` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC035 | `sec-rt-endpoint` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC036 | `sec-sys-hardware` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC037 | `sec-sys-execution` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC038 | `sec-sys-errors` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC039 | `sec-sys-recovery` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC040 | `sec-route-dynamic` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC041 | `sec-diag-bench` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC042 | `sec-diag-suite` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC043 | `sec-diag-npu` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC044 | `sec-diag-engines` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC045 | `sec-diag-foundry` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC046 | `sec-diag-providers` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC047 | `sec-diag-battery` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC048 | `sec-diag-lab` | developer | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC049 | `sec-humain-cost` | ? | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC050 | `sec-humain-api` | ? | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |
| SSC051 | `sec-humain-routing` | ? | tests/settings-ui.test.ts (deep links and rendering) | CONTRACT |

## Settings rows

| ID | Row | Group | How checked | Result |
|---|---|---|---|---|
| SRW001 | `Theme` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW002 | `Close button` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW003 | `Developer tools` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW004 | `Close reminder` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW005 | `Device choice` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW006 | `Auto goal` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW007 | `Runs on` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW008 | `Release when idle` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW009 | `Warm up while typing` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW010 | `Keep-alive` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW011 | `Loading strategy` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW012 | `Startup timeout` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW013 | `NPU memory cap` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW014 | `Context window` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW015 | `Cache precision` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW016 | `Cache in RAM` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW017 | `Power mode` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW018 | `Draft decoding` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW019 | `Draft strategy` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW020 | `Draft steps` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW021 | `Draft model` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW022 | `Fewest draft steps` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW023 | `Draft confidence` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW024 | `Offload layers` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW025 | `Vision encoder` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW026 | `Allow part-CPU loading` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW027 | `Runtime libraries` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW028 | `Runtime log level` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW029 | `Runtime update check` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW030 | `Thinking` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW031 | `Sub-agents` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW032 | `Keep long chats going` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW033 | `Turn budget` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW034 | `Calls per turn` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW035 | `Output per turn` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW036 | `Tools on / only` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW037 | `Files beside chat` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW038 | `Code check` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW039 | `Review model` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW040 | `Fix rounds` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW041 | `Which model writes` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW042 | `Auto-improve` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW043 | `Improve rounds` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW044 | `Improve time` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW045 | `Improve goal` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW046 | `Low-power slides` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW047 | `Follow skill's model` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW048 | `Chat cost estimates` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW049 | `HUMAIN capabilities` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW050 | `Fuse thinking` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW051 | `Fuse chat search` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW052 | `Chat location` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW053 | `Fuse chat model` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW054 | `Fuse chat API` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW055 | `Node chat model` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW056 | `Node chat API` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW057 | `Microphone` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW058 | `Dictation model` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW059 | `Dictation language` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW060 | `Show words live` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW061 | `Read-aloud voice` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW062 | `Read-aloud speed` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW063 | `Voice chat model` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW064 | `Interrupt by speaking` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW065 | `Send when I stop` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW066 | `Dictation runs on` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW067 | `Voice runs on` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW068 | `Mic threshold` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW069 | `Shortest speech` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW070 | `End silence` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW071 | `Smart silence` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW072 | `Interrupt threshold` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW073 | `Interrupt hold` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW074 | `Pause before replying` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW075 | `Voice speaker id` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW076 | `Runtime path` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW077 | `Show K-quants` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW078 | `Engine options` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW079 | `Dynamic model` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW080 | `General` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW081 | `Local Intelligence` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW082 | `Cloud Intelligence` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW083 | `About` | ? | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW084 | `Models library (install, remove, choose)` | library | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW085 | `HUMAIN connections` | web | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW086 | `HUMAIN Fuse connection` | fuse | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW087 | `HUMAIN Node connection` | node | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW088 | `HUMAIN API console` | web | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW089 | `Personal instructions (about me, tone, language)` | customize | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW090 | `Skills (step-by-step recipes)` | customize | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW091 | `Version and updates` | about | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW092 | `Bug report (copy diagnostics)` | about | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW093 | `About MKMN AI and privacy` | about | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW094 | `This PC (chip, RAM, NPU, driver)` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW095 | `Execution verification (NPU evidence)` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW096 | `Last error and server log` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW097 | `Local endpoint (OpenAI-compatible)` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW098 | `Model routing (the Dynamic model)` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW099 | `Single-model benchmark` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW100 | `Benchmark suite (all models)` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW101 | `Reset the NPU (recovery)` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW102 | `NPU load test` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW103 | `Engine comparison (runtime vs Foundry Local)` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW104 | `Foundry Local settings (server, cache, models)` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW105 | `Providers and artifact sources` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW106 | `Battery draw` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |
| SRW107 | `Prompt lab` | developer | tests/settings-ui.test.ts; tests/settings-fixes.test.ts | CONTRACT |

## Smart functions

| ID | Row | Area | How checked | Result |
|---|---|---|---|---|
| SMF001 | `Thinking` | Reasoning | tests/effort.test.ts | CONTRACT |
| SMF002 | `Tools only on /command` | Smart functions | manual check | CONTRACT |
| SMF003 | `Sub-agents` | Delegation | tests/subagents.test.tsx; tests/agentic.test.ts | CONTRACT |
| SMF004 | `Keep long chats going` | Smart functions | manual check | CONTRACT |

## Scripts

| ID | Script | Purpose | How checked | Result |
|---|---|---|---|---|
| SCP001 | `scripts/Backup-Original.ps1` | copy an original build aside before an overlay | manual check (not run in this session) | MANUAL |
| SCP002 | `scripts/Build-Windows.ps1` | build and stage the Windows installer | tests/powershell-native.test.ts; release build PASS (16/16 steps) | CONTRACT |
| SCP003 | `scripts/Bundle-Sidecar.ps1` | bundle the Node sidecar with esbuild | tests/powershell-native.test.ts; release build PASS | CONTRACT |
| SCP004 | `scripts/Check-After-Close.ps1` | verify the app after the window is closed | installed-app check | MANUAL |
| SCP005 | `scripts/Check-Installed-Sidecar.ps1` | drive the installed sidecar bundle over its protocol | installed-app check | MANUAL |
| SCP006 | `scripts/Live-Relaunch-Check.ps1` | check a live relaunch of the installed app | installed-app check | MANUAL |
| SCP007 | `scripts/Resolve-MkmnPaths.ps1` | resolve the MkmnPaths layout for scripts | tests/paths-contract.test.ts | CONTRACT |
| SCP008 | `scripts/Validate-Installer.ps1` | validate the built installer | release Installer check | MANUAL |
| SCP009 | `scripts/audit-context.mjs` | audit the context sent to a model | tests/audit-context.test.ts | CONTRACT |
| SCP010 | `scripts/bench-probe-spawns.ts` | list the processes a benchmark spawns | manual check (diagnostic only) | MANUAL |
| SCP011 | `scripts/bench-save-path.ts` | print the benchmark save path | tests/bench.test.ts | CONTRACT |
| SCP012 | `scripts/build-xblocks.js` | build the page-block runtime | tests/gameBlocks.test.ts; tests/xbuild.test.ts | CONTRACT |
| SCP013 | `scripts/check-language.mjs` | reject non-English, non-Arabic copy outside the allowlist | tests/language.test.ts | CONTRACT |
| SCP014 | `scripts/feature-matrix.mjs` | script | manual check | CONTRACT |
| SCP015 | `scripts/generate-brand-assets.mjs` | generate the brand image set | tests/brandAssets.test.ts | CONTRACT |
| SCP016 | `scripts/generate-feature-matrix.mjs` | script | manual check | CONTRACT |
| SCP017 | `scripts/generate-settings-schema.mjs` | script | manual check | CONTRACT |
| SCP018 | `scripts/generate-state-machines.mjs` | generate and check the state-machine files | tests/state-machines.test.ts | CONTRACT |
| SCP019 | `scripts/lib/BuildResult.ps1` | write the one build result and its exit code | tests/powershell-native.test.ts | CONTRACT |
| SCP020 | `scripts/lib/NativeCommand.ps1` | run one native command with a UTF-8 log and a real exit code | tests/powershell-native.test.ts | CONTRACT |
| SCP021 | `scripts/lib/lifecycle-scan.mjs` | find every lifecycle in the source for the state-machine inventory | tests/state-machines.test.ts | CONTRACT |
| SCP022 | `scripts/licenses.cjs` | collect third-party licence texts | tests/brandAssets.test.ts | CONTRACT |
| SCP023 | `scripts/nsis_extract.py` | extract the NSIS installer for inspection | release Installer check | MANUAL |
| SCP024 | `scripts/setup-arm64-libs.ps1` | place the ARM64 native libraries | manual check (native library setup) | MANUAL |
| SCP025 | `scripts/smoke-sidecar-chat.js` | smoke the sidecar chat path | ran live (test profile: chat with qwen3-1.7b-native on the NPU); PASS | CONTRACT |
| SCP026 | `scripts/smoke-sidecar-devtools.js` | smoke the sidecar developer tools | needs an NPU and the app host; BLOCKED | BLOCKED |
| SCP027 | `scripts/smoke-sidecar-humain.js` | smoke HUMAIN Fuse and Node end to end | ran live (saved keys, copies only): Fuse chat through the pipeline, chart block, web search with sources, named model error, embeddings, rerank, limits, voices, speech, transcription, image, files, batches; Node chat, healthz, realtime refusal named; PASS 21/21 | CONTRACT |
| SCP028 | `scripts/smoke-sidecar-sandbox.js` | smoke the sandboxed code runner | ran live (test profile: runTask/runCode/runCommand/media/launchSite); PASS | CONTRACT |
| SCP029 | `scripts/smoke-sidecar-setup.js` | smoke the sidecar setup state | ran live (test profile); PASS | CONTRACT |
| SCP030 | `scripts/smoke-sidecar-shutdown.js` | smoke the coordinated shutdown | ran live (test profile: appShutdown during active work); PASS | CONTRACT |
| SCP031 | `scripts/smoke-sidecar-voice.js` | smoke the voice sidecar | ran live (test profile: voiceApply/transcribe/speak/saveVoice); PASS | CONTRACT |
| SCP032 | `scripts/smoke-sidecar.js` | smoke the sidecar protocol | ran live (test profile: installDynamicModel + uninstall roundtrip); PASS | CONTRACT |
| SCP033 | `scripts/stage-sidecar-closure.cjs` | stage the sidecar dependency closure | tests/runtime-contracts.test.ts | CONTRACT |
| SCP034 | `scripts/tournament.mjs` | run the model tournament | manual check (benchmark only) | MANUAL |
| SCP035 | `scripts/vendor-anim.js` | copy the vendored animation libraries | tests/brandAssets.test.ts | CONTRACT |
| SCP036 | `scripts/vendor-icons.js` | copy the vendored icon set | tests/iconTableReady.test.ts | CONTRACT |
| SCP037 | `scripts/xblocks-smoke/art.cjs` | smoke the art block | tests/gameBlocks.test.ts | CONTRACT |
| SCP038 | `scripts/xblocks-smoke/battle.cjs` | smoke the battle block | tests/gameBlocks.test.ts | CONTRACT |
| SCP039 | `scripts/xblocks-smoke/calc.cjs` | smoke the calculator block | tests/gameBlocks.test.ts | CONTRACT |
| SCP040 | `scripts/xblocks-smoke/core.cjs` | smoke the block runtime core | tests/gameBlocks.test.ts | CONTRACT |
| SCP041 | `scripts/xblocks-smoke/dialog.cjs` | smoke the dialog block | tests/gameBlocks.test.ts | CONTRACT |
| SCP042 | `scripts/xblocks-smoke/harness.cjs` | drive the block smoke tests | tests/gameBlocks.test.ts | CONTRACT |
| SCP043 | `scripts/xblocks-smoke/map.cjs` | smoke the map block | tests/gameBlocks.test.ts | CONTRACT |
| SCP044 | `scripts/xblocks-smoke/platformer.cjs` | smoke the platformer block | tests/gameBlocks.test.ts | CONTRACT |
| SCP045 | `scripts/xblocks-smoke/timer.cjs` | smoke the timer block | tests/gameBlocks.test.ts | CONTRACT |
