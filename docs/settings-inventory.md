# Settings inventory

Generated from `src/shared/settingsSchema.ts` — the ONE declaration of every
stored key. Regenerate with `node scripts/generate-settings-schema.mjs --write`;
`--check` fails when this file is stale (pinned by `tests/settings-schema.test.ts`).

103 stored keys, 11 groups. A key with **hidden** in its
last column has no control of its own, for the reason recorded there; the schema
still declares its default, so nothing restates one.

## Groups

| Group | Keys | Everyday |
| --- | --- | --- |
| App settings | 5 | 2 |
| Models | 8 | 0 |
| Speed & memory | 23 | 5 |
| Chats & answers | 9 | 5 |
| Files & projects | 16 | 9 |
| Shared cloud tools | 2 | 0 |
| HUMAIN Fuse | 4 | 3 |
| HUMAIN Node | 2 | 1 |
| Voice | 19 | 9 |
| Developer | 15 | 0 |
| About | 0 | 0 |

## Every stored key

| Key | Type | Default | Allowed | Scope | Level | Group | Label | Applies | Control |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `appearance` | enum | `"system"` | `light` · `dark` · `system` | app | everyday | general | Theme | now | yes — general (sec-general-appearance) |
| `closeAction` | enum | `"quit"` | `quit` · `tray` | app | everyday | general | Close button | now | yes — general (sec-general-close) |
| `closeNoticeOff` | boolean | `false` |  | app | advanced | general | Close reminder | now | yes — general (sec-general-close) |
| `migrateLegacyData` | boolean | `false` |  | app | advanced | general | Legacy data copy | restart | hidden — read by the host's opt-in legacy-data migration (paths.rs); the installer offers it, no Settings control |
| `uiZoom` | number | `1` | 0.5 – 2 | app | advanced | general | Interface size | now | hidden — no reader found (Ctrl + / Ctrl - zoom is not persisted); kept so old files keep the key |
| `allowHybridLoad` | boolean | `false` |  | app | advanced | library | Allow part-CPU loading | model-reload | yes — library (sec-library-options) |
| `lastModelId` | model-ref | `null` | a model id, or empty | app | advanced | library | Last model | now | hidden — written with selectedModelId; no reader; kept so old files keep the key |
| `loadFailures` | object | `{}` |  | app | advanced | library | Failed model loads | model-reload | hidden — written by the load test of a model; a record, not a preference |
| `loadProfiles` | object | `{}` |  | app | advanced | library | Load profiles | model-reload | hidden — written when a benchmark profile is saved; a record, not a preference |
| `placements` | object | `{}` |  | app | advanced | library | Measured places | model-reload | hidden — written by the benchmark and the NPU load test; a record, not a preference |
| `quickModelIds` | string-list | `[]` |  | app | advanced | library | Pinned models | now | hidden — edited in the model menu's pin control, not in Settings |
| `selectedModelId` | model-ref | `null` | a model id, or empty | app | advanced | library | Chosen model | model-reload | hidden — the chosen model, edited from the model menu; not a Settings control |
| `showKQuants` | boolean | `false` |  | app | advanced | library | Show K-quants | now | yes — adv-runtime (sec-library-options) |
| `adaptiveState` | object | `{}` |  | app | advanced | models | Auto state | now | hidden — the automatic selector's last decision, kept for display and cooldown; a record, not a preference |
| `autoGoal` | enum | `"balanced"` | `balanced` · `battery_saver` · `fastest` | app | everyday | models | Auto goal | model-reload | yes — models (sec-models-compute) |
| `compute` | enum | `"npu"` | `cpu` · `gpu` · `npu` · `hybrid` | app | everyday | models | Runs on | model-reload | yes — models (sec-models-compute) |
| `computeMode` | enum | `"manual"` | `auto` · `manual` | app | everyday | models | Device choice | model-reload | yes — models (sec-models-compute) |
| `geniexNgl` | number | `-1` | -1 – 999 | app | advanced | models | Offload layers | model-reload | yes — models (sec-models-offload) |
| `idleReleaseSec` | number | `300` | 0 – 86400 | app | everyday | models | Release when idle | model-reload | yes — models (sec-models-retention) |
| `keepaliveSec` | number | `300` | 0 – 86400 | app | advanced | models | Keep-alive | model-reload | hidden — kept in step with idleReleaseSec by the retention editor; idleReleaseSec is the user-facing knob |
| `kvInRam` | boolean | `false` |  | app | advanced | models | Cache in RAM | model-reload | yes — models (sec-models-context) |
| `kvType` | enum | `"f16"` | `f16` · `q8_0` · `q4_0` | app | advanced | models | Cache precision | model-reload | yes — models (sec-models-context) |
| `loadingStrategy` | enum | `"demand"` | `always` · `demand` | app | advanced | models | Loading strategy | model-reload | yes — models (sec-models-retention) |
| `nctxMode` | enum | `"auto"` | `auto` · `2048` · `4096` · `8192` | app | advanced | models | Context window | model-reload | yes — models (sec-models-context) |
| `npuBudgetOverrideGB` | number | `null` | 1 – 64 | app | advanced | models | NPU memory cap | model-reload | yes — models (sec-models-memory) |
| `powerProfile` | enum | `"auto"` | `auto` · `burst` · `high_performance` · `sustained_high_performance` · `balanced` · `low_balanced` · `power_saver` · `high_power_saver` · `low_power_saver` | app | advanced | models | Power mode | model-reload | yes — models (sec-models-power) |
| `speculativeDecoding` | object | `{"enabled":false}` |  | app | advanced | models | Draft decoding | model-reload | hidden — the leaves (enabled, specType, draftTokens) are declared separately; the switch writes the object |
| `speculativeDecoding.draftMin` | number | `0` | 0 – 16 | app | advanced | models | Fewest draft steps | model-reload | yes — models (sec-models-speculative) |
| `speculativeDecoding.draftModel` | string | `""` |  | app | advanced | models | Draft model | model-reload | yes — models (sec-models-speculative) |
| `speculativeDecoding.draftPMin` | number | `0` | 0 – 1 | app | advanced | models | Draft confidence | model-reload | yes — models (sec-models-speculative) |
| `speculativeDecoding.draftTokens` | number | `4` | 1 – 8 | app | advanced | models | Draft steps | model-reload | yes — models (sec-models-speculative) |
| `speculativeDecoding.enabled` | boolean | `false` |  | app | advanced | models | Draft decoding | model-reload | yes — models (sec-models-speculative) |
| `speculativeDecoding.specType` | enum | `"ngram-simple"` | `ngram-simple` · `ngram-cache` · `ngram-mod` · `ngram-map-k` · `ngram-map-k4v` · `draft-simple` · `draft-mtp` · `draft-eagle3` | app | advanced | models | Draft strategy | model-reload | yes — models (sec-models-speculative) |
| `startupTimeoutSec` | number | `90` | 30 – 300 | app | advanced | models | Startup timeout | model-reload | yes — models (sec-models-retention) |
| `vitCompute` | string | `""` |  | app | advanced | models | Vision encoder | model-reload | yes — models (sec-models-offload) |
| `warmUpWhileTyping` | boolean | `true` |  | app | everyday | models | Warm up while typing | now | yes — models (sec-models-retention) |
| `autoCompact` | boolean | `true` |  | chat | everyday | chats | Keep long chats going | now | yes — build (sec-chats-long) |
| `effort` | enum | `"auto"` | `auto` · `off` · `low` · `medium` · `high` | message | everyday | chats | Thinking | now | yes — build (sec-chats-thinking) |
| `humainMode` | enum | `"local"` | `local` · `fuse` · `node` | app | everyday | chats | Chat location | now | yes — chats (sec-chats-location) |
| `privacy.retentionDays` | number | `null` | 1 – 3650 | app | advanced | chats | Keep chat records for | restart | hidden — no Settings control yet: set it in Config/settings.json; the sidecar reads it at start (src/core/retention.ts) |
| `subagents` | boolean | `false` |  | chat | everyday | chats | Sub-agents | now | yes — build (sec-chats-agents) |
| `toolsOnCommand` | boolean | `false` |  | chat | everyday | chats | Tools on / only | now | yes — behavior (sec-chats-tools) |
| `turnBudget` | object | `null` |  | chat | advanced | chats | Turn budget | now | hidden — the pair is edited as two selects; the policy owns the unset fallback |
| `turnBudget.maxCalls` | number | `120` | 1 – 100000 | chat | advanced | chats | Calls per turn | now | yes — build (sec-build-behavior) |
| `turnBudget.maxOutputTokens` | number | `100000` | 1 – 100000000 | chat | advanced | chats | Output per turn | now | yes — build (sec-build-behavior) |
| `agentGoal` | string | `""` |  | app | everyday | files | Improve goal | now | yes — build (sec-build-improve) |
| `agentLoop` | boolean | `false` |  | app | everyday | files | Auto-improve | now | yes — build (sec-build-improve) |
| `agentMinutes` | number | `30` | 1 – 480 | app | everyday | files | Improve time | now | yes — build (sec-build-improve) |
| `agentRounds` | number | `6` | 1 – 50 | app | everyday | files | Improve rounds | now | yes — build (sec-build-improve) |
| `autoCheck` | boolean | `false` |  | app | everyday | files | Code check | now | yes — build (sec-build-check) |
| `customInstructions` | string | `""` |  | app | advanced | files | About me | now | hidden — edited on the Customize page (the Personal instructions editor) |
| `customInstructions2` | string | `""` |  | app | advanced | files | About me (part 2) | now | hidden — second part of the personal instructions, edited on the Customize page |
| `customInstructions3` | string | `""` |  | app | advanced | files | About me (part 3) | now | hidden — third part of the personal instructions, edited on the Customize page |
| `deckLowPower` | boolean | `false` |  | app | everyday | files | Low-power slides | now | yes — build (sec-build-improve) |
| `openFilesBesideChat` | boolean | `true` |  | app | everyday | files | Files beside chat | now | yes — build (sec-files-panels) |
| `removedSkills` | string-list | `[]` |  | app | advanced | files | Removed skills | now | hidden — managed on the Customize page; the schema records the stored list |
| `reviewerModelId` | model-ref | `null` | a model id, or empty | app | everyday | files | Review model | now | yes — build (sec-build-check) |
| `reviewRounds` | number | `2` | 1 – 3 | app | advanced | files | Fix rounds | now | yes — build (sec-build-check) |
| `skillAutoModel` | boolean | `true` |  | app | everyday | files | Follow skill's model | now | yes — build (sec-build-improve) |
| `skills` | object | `[]` |  | app | advanced | files | Skills | now | hidden — edited on the Customize page; the schema records the stored list |
| `writers` | object | `{}` |  | app | advanced | files | Which model writes | now | yes — build (sec-build-writers) |
| `humainDisabledFeatures` | object | `{}` |  | app | advanced | web | HUMAIN capabilities | now | yes — search (sec-humain-features) |
| `humainUsdRates` | object | `{}` |  | app | advanced | web | Chat cost estimates | now | yes — search (sec-humain-cost) |
| `humainChatSearch` | enum | `"off"` | `off` · `search` · `research` | app | everyday | fuse | Fuse chat search | now | yes — fuse (sec-humain-fuse-chat) |
| `humainFuseChatApi` | enum | `"chat/completions"` | `chat/completions` · `responses` · `messages` | app | advanced | fuse | Fuse chat API | now | yes — fuse (sec-humain-fuse) |
| `humainFuseEffort` | enum | `"default"` | `default` · `none` · `minimal` · `low` · `medium` · `high` · `xhigh` · `max` | app | everyday | fuse | Fuse thinking | now | yes — fuse (sec-humain-fuse-chat) |
| `humainFuseModel` | string | `""` |  | app | everyday | fuse | Fuse chat model | now | yes — fuse (sec-humain-fuse) |
| `humainNodeChatApi` | enum | `"chat/completions"` | `chat/completions` · `responses` · `messages` | app | advanced | node | Node chat API | now | yes — node (sec-humain-node) |
| `humainNodeModel` | string | `""` |  | app | everyday | node | Node chat model | now | yes — node (sec-humain-node) |
| `voice.allowInterrupt` | boolean | `true` |  | app | everyday | voice | Interrupt by speaking | now | yes — voice (sec-voice-chat) |
| `voice.autoSend` | boolean | `true` |  | app | everyday | voice | Send when I stop | now | yes — voice (sec-voice-chat) |
| `voice.endSilenceMs` | number | `700` | 200 – 4000 | app | advanced | voice | End silence | now | yes — voice (sec-voice-calibration) |
| `voice.interruptLevel` | number | `0.056` | 0.01 – 0.125 | app | advanced | voice | Interrupt threshold | now | yes — voice (sec-voice-calibration) |
| `voice.interruptMs` | number | `1000` | 200 – 4000 | app | advanced | voice | Interrupt hold | now | yes — voice (sec-voice-calibration) |
| `voice.liveText` | boolean | `true` |  | app | everyday | voice | Show words live | now | yes — voice (sec-voice-dictation) |
| `voice.micDeviceId` | string | `""` |  | app | everyday | voice | Microphone | now | yes — voice (sec-voice-mic) |
| `voice.minLevel` | number | `0.015` | 0.002 – 0.125 | app | advanced | voice | Mic threshold | now | yes — voice (sec-voice-calibration) |
| `voice.minSpeechMs` | number | `300` | 80 – 2000 | app | advanced | voice | Shortest speech | now | yes — voice (sec-voice-calibration) |
| `voice.smartEnd` | boolean | `true` |  | app | advanced | voice | Smart silence | now | yes — voice (sec-voice-calibration) |
| `voice.sttCompute` | enum | `"cpu"` | `cpu` · `npu` | app | advanced | voice | Dictation runs on | model-reload | yes — voice (sec-voice-calibration) |
| `voice.sttLanguage` | string | `""` |  | app | everyday | voice | Dictation language | now | yes — voice (sec-voice-dictation) |
| `voice.sttModelId` | model-ref | `null` | a model id, or empty | app | everyday | voice | Dictation model | now | yes — voice (sec-voice-dictation) |
| `voice.ttsCompute` | enum | `"cpu"` | `cpu` · `npu` | app | advanced | voice | Voice runs on | model-reload | yes — voice (sec-voice-calibration) |
| `voice.ttsModelId` | model-ref | `null` | a model id, or empty | app | everyday | voice | Read-aloud voice | now | yes — voice (sec-voice-tts) |
| `voice.ttsSid` | number | `0` | 0 – 1000 | app | advanced | voice | Voice speaker id | model-reload | yes — voice (sec-voice-tts) |
| `voice.ttsSpeed` | number | `1` | 0.5 – 2 | app | everyday | voice | Read-aloud speed | now | yes — voice (sec-voice-tts) |
| `voice.voiceModelId` | string | `""` |  | app | everyday | voice | Voice chat model | now | yes — voice (sec-voice-chat) |
| `voice.waitMs` | number | `2500` | 500 – 10000 | app | advanced | voice | Pause before replying | now | yes — voice (sec-voice-calibration) |
| `autoResetNpu` | boolean | `true` |  | app | advanced | developer | Auto NPU reset | now | hidden — nothing in the desktop build acts on it (no automatic NPU reset there); the NPU load test shows it off and disabled, saying so; kept so old files keep the key |
| `developer` | boolean | `false` |  | app | advanced | developer | Developer tools | now | yes — adv-system (sec-sys-devtools) |
| `dynamic` | object | `{}` |  | app | advanced | developer | Dynamic model | model-reload | hidden — the Dynamic model's leaves are edited in the routing editor; the object itself has no control |
| `dynamic.askModel` | boolean | `true` |  | app | advanced | developer | Ask the model | model-reload | hidden — declared but never read; kept so old files keep the key |
| `dynamic.profile` | string | `""` |  | app | advanced | developer | Memory profile | model-reload | hidden — edited in the Dynamic model's routing editor |
| `dynamic.router` | boolean | `true` |  | app | advanced | developer | Use the router | model-reload | hidden — edited in the Dynamic model's routing editor |
| `dynamic.routerModel` | string | `""` |  | app | advanced | developer | Router model | model-reload | hidden — edited in the Dynamic model's routing editor |
| `dynamic.table` | object | `{}` |  | app | advanced | developer | Choice table | model-reload | hidden — edited in the Dynamic model's routing editor |
| `geniexLog` | enum | `"none"` | `none` · `error` · `warn` · `info` · `debug` · `trace` | app | advanced | developer | Runtime log level | model-reload | yes — adv-runtime (sec-rt-genies) |
| `geniexPath` | string | `null` |  | app | advanced | developer | Runtime path | restart | yes — adv-runtime (sec-rt-genies) |
| `geniexSkippedUpdate` | string | `null` |  | app | advanced | developer | Skipped runtime update | now | hidden — written when the optional runtime update is skipped; a record, not a preference |
| `geniexUpdateCheck` | boolean | `false` |  | app | advanced | developer | Runtime update check | model-reload | yes — adv-runtime (sec-rt-genies) |
| `pinnedGeniexVersion` | model-ref | `null` | a model id, or empty | app | advanced | developer | Pinned version | restart | hidden — declared but never read; kept so old files keep the key |
| `qairtLib` | string | `""` |  | app | advanced | developer | Runtime libraries | model-reload | yes — adv-runtime (sec-rt-genies) |
| `runtime` | object | `{}` |  | app | advanced | developer | Engine options | model-reload | hidden — the llama.cpp engine's advanced fields, edited field-by-field in the runtime panel; unset lets the engine decide |

## Findings

<!-- FINDINGS:START -->
None recorded for this release.
<!-- FINDINGS:END -->
