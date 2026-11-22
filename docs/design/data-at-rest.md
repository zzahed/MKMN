# Data at rest

What MKMN keeps on the PC, where, how it is protected, and how it goes away.
Written for the 2026-11-17 engineering review (finding E). The path layout is
`mkmnPaths()` in `src/shared/paths.ts`; never rebuild a path from this page.

## Protection, stated plainly

MKMN does not encrypt chats, documents or journals itself. They are plain files
or browser storage under the person's Windows profile, protected by the
profile's file permissions and by whatever disk encryption the PC uses
(BitLocker or Device Encryption). Anyone who can sign in as that person, or
read that disk unencrypted, can read them. Do not describe MKMN data as
"encrypted at rest" because it stays on the PC.

The one secret MKMN encrypts is the HUMAIN API key: Windows DPAPI for the
current user (`src/sidecar/humainVault.ts`).

Encrypting the rest with DPAPI is possible. It would not protect against
anything that already runs as the person, and it would make backups and
support copies unreadable on another account. Whether to do it is an owner
decision. Nothing here decides it.

## The stores

| What | Where | Holds | Goes away when |
| --- | --- | --- | --- |
| Chats | The window's storage (`opennpu.conversations`), WebView2 profile `%LOCALAPPDATA%\app.mkmn.desktop\EBWebView` | Every message, attached document text, summaries | The person deletes the chat (8 s Undo), or clears the app's data |
| Projects, artifacts, tasks (window copy) | The same storage (`mkmn.projects`, `mkmn.artifacts`, `mkmn.tasks`) | Project files' text, generated files | The person deletes them |
| Artifact versions | The same storage (`mkmn.versions.<id>`) | Every version of every file | Deleting a file deletes all its versions |
| Run journals | `Workspace\harness\*.jsonl` | Each step of a turn: sections sent, replies | **Deleting the chat** (since this review: the run header names the chat, `src/core/harness/forget.ts`). Journals written before that, and runs with no chat (scheduled tasks, benchmarks), stay until removed by hand |
| Offloaded payloads | `Workspace\harness\offload\` | Long replies, a chat's folded history, a project's full knowledge text | The chat's own payloads go with the chat. A project's knowledge payload goes with the project (`removeKnowledgeFiles`, `src/core/knowledge/store.ts`) |
| Knowledge index | `Workspace\knowledge\<project>.json` | The project's files cut into sections | Rebuilt when the files change. **Deleting the project** deletes it (`removeKnowledgeFiles`) |
| Search vectors | `Workspace\knowledge\<project>.vectors` | Embeddings of the sections | As the index: deleted with the project |
| Scheduled tasks | `tasks.json` in the data folder | Task prompts and schedules | The person deletes the task |
| Settings | `Config\settings.json` | Choices, measured placements, load records | Never by itself (written only by the host) |
| Logs | `Logs\mkmn.log`; `%LOCALAPPDATA%\app.mkmn.desktop\logs\MKMN.log` (2 MB, three kept) | Lifecycle lines, errors. Task text and window contents of Computer Use are left out on purpose | Rotation |
| Models | GenieX's cache, Foundry Local's cache, `Workspace\voice-models`, `Embeddings` | Model files | The person removes them |
| HUMAIN key | The vault file, DPAPI | The key, encrypted | The person removes the key |

## Not covered yet (open items)

- No retention period: journals, payloads and versions are kept until deleted.
- "Copy full log" and support copies are made by the person; nothing checks
  them for document text before they are shared.
- Secure deletion (overwriting before removal) is not done. On an SSD with
  disk encryption it would add little; without disk encryption a removed file
  may be recoverable.
