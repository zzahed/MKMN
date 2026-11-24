# Computer Use v1 — design

Status: implemented (Windows ARM64). This document is the contract for
MKMN's first Computer Use feature: the person picks ONE window, MKMN reads its
visible content through accessibility and works in it one step at a time, on the
NPU, entirely on this PC.

## What v1 is

An agent run, started from Chat, that drives one window of one program the person
chose. The loop is the sidecar's: **observe → propose one action → validate →
execute → re-observe and verify → repeat**, bounded, with a verdict at the end.
v1 is **accessibility-first**: the only thing the agent sees is the UI
Automation tree of the granted window, and the only way it touches the window is
through the patterns that tree exposes. There is no synthetic mouse, no
screenshot, no keystroke injection — typing happens through the Value pattern,
which does not need focus and cannot press Enter anywhere.

That last property is the safety story of v1: the action set has no keyboard
path at all, so an action that "sends" is not something the agent can do by
accident. "Prepare an unsent draft" is the designed success case, and the
closed action set is what guarantees the *unsent*.

## Pieces and ownership

```
renderer (AgentPanel)          sidecar (computerUse.ts)        host (Tauri, Rust)
────────────────────           ───────────────────────         ──────────────────
pick window  ──agent_begin_run──────────────────────────────▶  validate + record GRANT
task + Start ──agentRun (sidecar)───────────────────────────▶  (forwarded, acked at once)
                               the loop:                       every observe/act:
                               observe ──agentObserve────────▶ validate grant → driver
                               propose (local model, NPU)      validate → agent-desktop.exe
                               validate                        (private stdio, pinned)
                               act ────────agentAct──────────▶
                               re-observe + verify
progress ◀──sidecar-event("agentRun")──emitEvent────────────
Stop ─────────agent_stop────▶  abort → cancelled verdict       grant cleared
```

- The **Tauri host** owns the driver process (supervision, pin check, bounded
  calls, shutdown), the window grant (validation, storage, enforcement on every
  driver call), action validation (shape + grant), and cancellation (it stops
  forwarding driver calls the moment a stop is asked).
- The **Node sidecar** owns the loop: what to observe, what to ask the model,
  whether an action is sane, whether it verified. It never spawns or talks to
  the driver directly — every driver call is a host capability
  (`agentListWindows`, `agentObserve`, `agentAct`, `agentEndRun`).
- The **renderer** owns the conversation with the person: the window picker,
  the progress lines, the Stop button. It never calls the driver.

## The window grant

A grant is `{ hwnd, pid, title, process }` for exactly one top-level window,
recorded by the host for the life of ONE run.

- The list the person picks from comes from the driver's `listWindows`
  (visible top-level windows with a title); the host removes its own process's
  windows before showing it — the agent never operates MKMN itself.
- `agent_begin_run` (Tauri command) validates: the window exists, is visible,
  is top-level, its pid and title still match what the driver reported, and no
  run is active. It then records the grant. Everything else is refused.
- **Every** driver call (`observe`, `act`) carries the hwnd; the host refuses
  any call whose hwnd does not match the live grant, and re-validates the
  window (alive, same pid) before forwarding. A grant outlives nothing: it is
  cleared when the run settles (`agentEndRun` from the sidecar's `finally`),
  when the person stops, or when the app shuts down.
- One grant at a time. A second begin while one is live is refused with the
  honest reason; the person stops the first run to start another.

## The driver: a pinned native `agent-desktop` build behind private stdio

## The driver: a pinned native `agent-desktop` build behind private stdio

**Provenance of the binary.** The driver is not a third-party artifact and no
external "agent-desktop" build exists anywhere in this repository (no binary is
committed; no other origin is referenced). It is compiled from
`src-tauri/src/bin/agent-desktop.rs` — a binary target of the host's own crate
— by the same `cargo build` invocation that produces the app, for the same
`aarch64-pc-windows-msvc` target. The compiled executable carries this crate's
source paths in its own panic locations, and at startup it announces exactly
the name, version and protocol constants compiled from
`src-tauri/src/agent_wire.rs` (`agent-desktop` / `1.0.0` / protocol `1`); the
host refuses any other announcement with both versions named, so a foreign
binary can never be adopted as the driver. The installed app resolves the
driver in this order: the `MKMN_AGENT_DESKTOP` environment variable (tests),
the installer's `Runtime\agent-desktop.exe` (bundled by `installer.nsi` from
the release build), then the cargo `target\{debug,release}` output beside the
host (development).

The driver is `agent-desktop.exe`, a small native binary shipped with the app
(built from `src-tauri/src/bin/agent-desktop.rs`, same crate as the host). It
speaks line-delimited JSON (`src-tauri/src/agent_wire.rs`, shared by both
sides) on stdin/stdout and nothing else.

- **Private stdio**: spawned by the host with piped stdio,
  `CREATE_NO_WINDOW`, assigned to the app's job object, supervised with the
  same generation discipline as the Node sidecar (`src-tauri/src/sidecar.rs`):
  liveness by reaping `try_wait`, generation-scoped pending calls, bounded
  kill. A wedged COM call is bounded by a per-call timeout in the host; the
  driver that misses it is killed and the next call spawns a fresh generation.
- **Pinned**: on start the driver announces
  `{ name, version, protocol }`; the host holds the pinned constants and
  refuses any other build with an error naming both versions. v1 pins the
  version string; a SHA-256 manifest (the `installerTrust` pattern) is the
  noted follow-up.
- **Methods** (host → driver, one `req`/`res` each):
  - `listWindows {}` → visible top-level windows: `hwnd, pid, title, process, className`.
  - `observe { hwnd, maxNodes }` → a fresh accessibility snapshot of that
    window: a flat node list (`ref, role, name, value, className, enabled,
    offscreen, rect, patterns`) in traversal order, plus `observeGen` and
    whether the window has focus.
  - `act { hwnd, ref, action }` → performs one action through the element's
    patterns. Never types, never clicks coordinates.
- **References are window-scoped and single-observe**: every observe bumps the
  window session's generation; a ref is `e<gen>.<index>` and is valid only
  against that generation. Acting on an older ref answers `staleRef`. There is
  no way to hold a reference across actions — each action works from the fresh
  snapshot taken just before it.

## The action schema

One closed union, validated in three places (sidecar schema, host grant+shape,
driver element+pattern):

| kind | fields | driver pattern | verify by |
|---|---|---|---|
| `click` | `ref` | Invoke | element still present and reports a state change when it has one; otherwise `unverified` |
| `setValue` | `ref`, `text` | Value | the element's value reads back equal to `text` |
| `toggle` | `ref` | Toggle | the toggle state flipped |
| `select` | `ref`, `value` | ExpandCollapse + SelectionItem (by exact name) | the selection reports the chosen name |
| `expand` / `collapse` | `ref` | ExpandCollapse | the expand state changed |

Deliberately absent in v1: keyboard events, coordinate/mouse actions, scroll,
drag, window management (move/close), anything that reads or writes files, any
network access. The driver refuses unknown kinds with the reason named.

## The run lifecycle

The run's overall result is machine `agentRun` in
`src/shared/stateMachines.json` (one of the registry machines; the step phases
below are supporting labels the events carry, not a machine):

- `running` — granted and looping.
- `done` — the model declared the task complete AND every executed action
  verified on the re-observe. Only this settles `done`.
- `unresolved` — the run ended with honest uncertainty: any executed action
  that could not be verified, the step limit reached, or the model gave up
  after changes were made. The event names why.
- `failed` — the window closed or changed owner, the driver died or was never
  found, the model server never answered, or the proposal was unusable twice
  before anything was executed. Real faults, named.
- `cancelled` — the person's Stop. Never `failed`; matches the house rule that
  the person's stop is a cancel.

One run at a time; the loop is `async` in the sidecar and streams
`agentRun` events (state, step index, phase, a human line, the executed
actions, the verdict) after every step, so Chat can show progress as it runs.

## The loop, precisely

`src/sidecar/computerUse.ts`, dependency-injected (`driver`, `model`, `emit`,
`signal`, limits) so tests drive it with fakes:

1. **Observe** (fresh, window-scoped, capped at 300 nodes): render the tree as
   an indented text list for the model: `e12 Button "Send" [click]`.
2. **Propose ONE action**: the local chat model (the same NPU-first path the
   chat uses — `collect` over the host-supervised server; never a cloud, never
   a silent CPU fallback) answers a closed JSON: one action, or
   `{kind:"done", summary}`, or `{kind:"giveUp", reason}`. Unparseable or
   schema-invalid answers get ONE re-ask with the exact fault; then the run
   settles (no actions executed → `failed`, else `unresolved`).
3. **Validate**: schema → grant (host) → the ref exists in the current
   observe, the element is enabled and on-screen, the action's pattern is
   available. An invalid action is reported to the model as the next observe's
   note, not executed.
4. **Execute** via the host. `staleRef` (the window changed under us) →
   re-observe and re-propose, without executing; a run keeps going on stale
   references instead of failing on them, bounded by the step limit.
5. **Re-observe and verify**: the action's verify rule from the table above;
   the window-gone check runs here too (→ `failed`). Focus changes are
   recorded and reported to the model (typing does not need focus; a focus
   change is never a reason to act on another window — the grant does not
   move).
6. **Repeat** until the model says `done`/`giveUp`, the step limit (12) or the
   run budget is reached, the signal fires, or a fault above.

Every wait is bounded: model calls ride the chat transport's 45 s no-progress
window; each driver call has a host-side timeout (10 s); the whole run has a
wall-clock ceiling (10 min). Stop (`agentStopRun`, the panel's button, or the
app shutdown) aborts the signal; the loop checks it between every step and
races it against every wait, so cancellation lands in seconds, settles
`cancelled`, and emits its terminal event through a `finally`.

## Success criteria for v1

1. **Read visible content**: given a granted window, the loop's observe puts
   the window's visible text content (roles, names, values) in the model's
   context, and the model's proposal quotes content it can only know from that
   tree. Pinned by `tests/computerUse.test.ts` (fake driver + fake model).
2. **Prepare an unsent draft**: given a window with a text field, the loop
   performs `setValue` into it and verifies the field reads back the text —
   and the action set makes "send" impossible. Same test.
3. **Cancellation**: a Stop mid-loop settles `cancelled`, stops driver calls,
   and emits the terminal event.
4. **Stale targets**: a stale ref is recovered by re-observing; a closed
   window settles `failed` with the reason.
5. **Uncertain outcomes**: an action the re-observe cannot verify settles
   `unresolved`, never `done`.
6. **Live on this PC (ARM64)**: the pinned driver binary is built for ARM64
   and driven over its real stdio against real windows (list, observe, act on
   a text field); the loop itself is verified by the unit tests with the same
   wire shapes. The full installed-app acceptance pass is named as not done
   until the installer checklist runs.

## Deliberately not in v1

Screenshots and vision (the infra exists — `lookAtShot` — but v1 proves the
accessibility path), keyboard/mouse emulation, multi-window runs, cross-app
workflows, a settings page (the panel lives in Chat; the model is the chat's
selected model), and any cloud model path. Each is a v2 decision on its own.

## The composer flow

The panel sat ABOVE the composer as its own island with its own task
input: the person had to find it, and the task lived apart from the chat draft.
v2 folds Computer Use into the composer the chat already has.

### Mode and entry

- A visible **Computer Use** chip sits in the composer bar, beside the other
  composer controls, with `aria-pressed` and a keyboard focus path (Tab order
  reaches it from the composer). It is the only entry point.
- Turning it on switches the SAME composer into agent mode: the textarea the
  person always types in holds the task, with an agent placeholder. Nothing
  about the draft changes owner — it is the chat's draft state, so text typed
  before and after picking a window simply stays.
- The person may type the task BEFORE choosing a window. Nothing requires a
  window until the run starts.
- In agent mode the composer's send control becomes **Run task** — one short,
  stable label on a properly sized primary button. The run control NEVER names
  the window: the picked window's name lives in the target row below, so a long
  title can neither overflow the button nor push the composer bar wider than
  the page. When it is disabled its tooltip says exactly what is missing (type
  the task first / choose a target / pick a model); when it is ready it says
  what will happen (`Start the run in "…" (the window grant is asked fresh for
  every run)`, or `Edit a copy of "…" (the original stays untouched)`).
  Pressing Enter with no target picked still opens the picker instead of
  failing. Turning the chip off returns the composer to chat mode with the
  draft intact. At narrow widths the composer bar WRAPS instead of clipping:
  the dictation and run controls drop to their own row (the run control stays
  right-aligned) and the page never gains horizontal scroll from the composer.

### The window picker

- Opens above the composer as a listbox (`role="listbox"`, options
  `role="option"`), driven by the keyboard: Down/Up move the highlighted
  option, Enter picks, Escape closes, Tab closes. The highlighted option has
  `aria-selected`.
- Each option shows the **friendly app name** (Word, Notepad, File Explorer —
  from the process, with a de-`exe`-and-capitalize fallback for anything
  unmapped; the raw process stays in the sub-line's own tooltip) and the
  **full window title** — never a truncated-only title.
- The full title is reachable BOTH ways: by mouse through the option's tooltip
  (`title`), and by keyboard through a **detail line under the list** that
  follows the highlight (Down/Up or mouse hover) and spells the whole thing
  out — friendly name, full title, duplicate suffix — in an `aria-live` region.
  The option's `aria-label` carries the same full text for screen readers.
- Duplicate titles are distinguishable: when two windows of the same process
  carry the same title, the later ones are labelled `· window 2 (of 2)` and so
  on, and every option also names the app, so "Untitled - Notepad" twice is
  still pickable with confidence.
- A **Refresh** control re-lists the windows (windows open and close while the
  picker sits there); the empty case says no other program's window is showing.
- The **target row sits above the composer and is ALWAYS visible in agent
  mode**: `Target: No window selected` with a **Choose window** control before
  any pick; after one, the app's friendly name and the window title (full
  title in the tooltip) with **Change window** — or the document's name with
  **Change file** for the Edit-a-copy road. Either control reopens its picker
  without touching the task draft, and a landed pick or a closed picker hands
  focus back to the task textarea, so the keyboard walk never dead-ends. The
  next run asks for its own fresh grant, so re-pointing a task at another
  window costs one click and nothing else.

### During and after the run

- While a run is live the composer form is replaced by a run strip that keeps
  the **target** (window title) and the **Stop** button visible at all times,
  with the run's progress lines under them. The composer keeps its height —
  the page does not jump.
- The final outcome is shown **beside the task**: when the run settles, the
  composer comes back with the task text still in it, and the verdict line
  (`Done: …`, `Stopped.`, `Unresolved: …`, `Failed: …`) renders directly above
  the textarea until the person edits the task or starts a new run. The draft
  is never cleared by an error: a refused start leaves the task in the box
  with the error beside it.
- **A fresh host grant for every run**: the panel asks the host for a new
  grant (`agentBeginRun`) at the start of EACH run — a grant from a finished
  run is never reused — and the grant dies with the run as before.

### Verification and stop behavior

- The driver's observe must carry the field's FULL value on the wire (bounded,
  prefix-cut at 8192 characters, no ellipsis marker inside the value), or a
  verified write longer than the old 160-character cap can never read back
  equal and every long rewrite dies "Could not verify". The value shown to the
  MODEL is capped separately (2048 characters, with a visible
  `…(+N characters not shown)` marker), so context stays bounded while verify
  stays honest.
- Stop failures are surfaced in the run strip, never swallowed: a Stop that
  errors says so beside the target.

### Word interaction and logging

- Some windows hold text the action union cannot write. Word's document canvas
  ("Page 1 content", role Edit) exposes no UIA Value pattern — Notepad's edit
  control does, and that difference is the whole story of the first-step
  failure: the observe honestly offered the canvas nothing, the model kept
  picking the one element that looks like the page, validation refused it
  twice, and the run died before any action. The contract now says so three
  ways: the canvas's text still rides the observe (TextPattern, read-only,
  tightly capped at 1024 characters) so the model sees what it is asked to
  change; a refused proposal names the elements that DO accept the action (or
  says plainly that nothing does, and offers giveUp as the honest exit); and
  the double-refusal settle carries that same limitation to the person.
- A small model's JSON is repaired, not worshipped: raw control characters
  INSIDE string literals (a multiline write with real newlines) are escaped
  and the parse retried once after the strict parse fails. A raw newline in a
  JSON string means \n unambiguously; quotes, escapes and structure are never
  touched.
- The app log is append-only whole lines: one write per line, not one write
  per format piece — `writeln!` on a File issues a syscall per piece and
  concurrent writers shred lines at piece granularity, which is how a release
  build's test flake exposed a field bug.
- Writing INTO Word (keyboard or coordinate input, per-character typing into
  the canvas) stays a separate design decision, deliberately not taken in
  The action union has no keyboard or coordinate kind on purpose (the
  Enter-safety guarantee), so until that decision is made the honest outcome
  for a Word write is the named read-only refusal — zero actions, the
  document preserved, the limitation on the record.

### Composer behavior

- The run control's label is a CONSTANT ("Run task") and the target row above
  the composer carries the window's name — this is what makes clipping
  structurally impossible for the button: the measured button never changed
  (79×79 CSS px) while the row's tooltip carried the full 79-character title.
  Before this contract, `Run in [window]` overflowed the icon-sized Send
  button at any width and created horizontal scroll at narrow ones.
- The disabled tooltip must name what is missing in order, and the walkthrough
  verified each transition: no task and no target → "type the task first and
  choose a target"; task typed → the target half only; both present → the
  ready description with the full title and the fresh-grant sentence.
- The full window title is reachable three ways and the pass verified all
  three: the option's hover tooltip, the `aria-label`
  (`Notepad — <full title>`), and the detail line under the list that follows
  the highlight by BOTH roads — real mouse hover and arrow keys — and
  re-lands when the other road takes it back.
- Narrow widths found a real defect the unit tests (jsdom, no layout) cannot
  see: at a 480px page the composer bar's fixed-width controls (343px of
  plus/badge/chip/mic/run) overflowed the 250px column and propagated
  horizontal scroll to the page. The fix is a WRAP, not a shrink: the bar
  drops the dictation and run controls to their own row (the run control
  stays right-aligned via auto margin) and the page keeps
  `scrollWidth <= clientWidth` everywhere — verified with the LONG title
  picked, at 480px, with the picker open, and at full width.
- The picked row intentionally shows a HEAD-truncated title (first 34
  characters) with the full title in its tooltip — so matching a window in
  the row means matching its beginning, while the picker OPTION carries the
  full title and matches anywhere in it.
- The live run wrote the expected sentence into the long-title Notepad
  (exact driver readback equal), settled `Done: …` with exactly one period,
  and a second run stopped mid-flight with a bare `Stopped.` verdict and the
  task kept in the composer. A stop check that waits even six seconds can
  lose the race to a fast model on a small task — click Stop promptly after
  the strip appears, or use a many-step task.
- Known narrow-width limitation OUTSIDE the composer, on the record not in
  the fix: old transcript agent cards (`.ag`/`.notices` from earlier
  conversations) can still exceed a 480px page width and scroll the page
  horizontally. The composer never contributes to it after the wrap fix.


