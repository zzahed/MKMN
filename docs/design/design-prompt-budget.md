# Design: a budget for the app's own instructions

Status: implemented (`INSTRUCTION_BLOCKS` in `src/core/prompts.ts`, `tests/prompt-budget.test.ts`).
Measurements were taken on installed GenieX models (see "Measurements" below).

## The problem, in one paragraph

The chat route sends the model a system prompt of about **3,057 tokens** (estimated by
the app's own counter) assembled by `buildSystemPrompt` (`src/core/projects.ts`). At a
4096-token window the room for the whole request is **2,868 tokens** (4096 minus the
1,228-token reply reserve). A seven-token request — "write me a program for hello
world" — was therefore refused before anything was sent: 3,075 > 2,868. The request
never reached the model. The real server, asked afterwards, counted the same prompt at
**2,494 tokens**, so the request would in fact have fit; the refusal came from the
app's own arithmetic on its own text. `fitMessages` (`src/core/context.ts`) can cut
files, history and attachments, but **never the system message** (line 97: `sysAt`
protects index 0), and the overflow notice it produced told the person to "shorten the
question" — advice that could not help, and was false.

## Root cause chain

1. **One monolithic system prompt for every artifacts request.** `buildSystemPrompt`
   joins VOICE_RULES (129 tok) + ARTIFACT_INSTRUCTIONS (1,566 tok) + VISUAL_OVERVIEW
   (670 tok) + BLOCK_INSTRUCTIONS (405 tok) — plus project text, custom notes, the
   auto-loaded skill and whatever the sidecar appends (search 279, images 223,
   sub-agents 269). Every request that can produce a file gets all of it, including
   the **813 tokens of Word/PowerPoint/Excel format rules** for a request that asks
   for a Python program.
2. **A build failure falls back to the biggest prompt in the app.** In `stepwise`
   (`src/core/build.ts`), the "several separate files?" closed question is asked first
   when the intent is "new". A non-yes/no answer (common on a 1B model) leaves the
   direct plan unset, so the planner is called; an unusable planner reply makes
   `parsePlan` return `mode:"answer"` (build.ts:219 — it never throws on garbage),
   and the answer path returns `handled:false` (build.ts:768). The chat orchestrator
   (`chatOrchestrator.ts:657-670`) then answers through the main chat route — **with
   the full 3,057-token system prompt**. The planner catch (build.ts:718-722 →
   `passthrough()`, on stream errors) lands in the same place. Nothing is shown to
   the person about the failed plan.
3. **The window is decided in three places that can disagree.** The sidecar passes an
   explicit window only when a kept load profile exists (`effectiveLoad`,
   `src/core/npuLoad.ts:71`); otherwise the Rust host decides by RAM tier
   (`memory_estimator.rs:307`: free RAM > 12 GB → 8192, < 6 GB → 2048, else **4096**).
   The catalog's `recommendedContext` (16384 for this model) is **never consulted**
   for the serve default. Meanwhile the renderer's context meter and the sidecar's
   helper routes fall back to `entry.recommendedContext` when the served window is not
   reported — so the app can budget against 16384 while the server runs 4096. That is
   why this model served at 4096: free RAM was between 6 and 12 GB at start.
4. **The error lied.** `fitMessages`' floor note (context.ts:139) says "Shorten the
   question…" even when the question is 7 tokens and the system prompt is 3,057.

### Measurements (app's own estimator, `tokensOf`)

Section sizes: ARTIFACT_INSTRUCTIONS 1,566 (core create/edit+icons 158, edit blocks
114, markdown-drawn-blocks line 241, **office 813**), VISUAL_OVERVIEW 670,
BLOCK_INSTRUCTIONS 405, VOICE_RULES 129, SEARCH 279, IMAGE 223, SUBAGENT 269,
worker 64, skill prompt 76.

Per route and window (request: "write me a program for hello world", no history):

| route | prompt (est) | 2048 (budget 1,434) | 4096 (budget 2,868) | 8192 (budget 6,144) | 16384 (budget 14,336) |
| --- | --- | --- | --- | --- | --- |
| chat, full system prompt (the fallback) | 3,075 | **overflow** | **overflow** | fits | fits |
| chat, plain question ("hi friend") | 11 | fits | fits | fits | fits |
| planner (build) | 791 | fits | fits | fits | fits |
| yes/no closed question | 281 | fits | fits | fits | fits |
| deck planner | ~1,224 + text | tight | fits | fits | fits |
| slide writer | ~1,107 + text | tight | fits | fits | fits |
| template fill | 308 + schema + text | fits | fits | fits | fits |
| site plan | 281 + schema | fits | fits | fits | fits |
| calc-sheet steps | 61 + schema | fits | fits | fits | fits |
| compaction summary | 229 + text | fits | fits | fits | fits |
| sub-agent worker | 64 + task | fits | fits | fits | fits |
| improve / review / repair | 106-256 | fits | fits | fits | fits |

Only the chat fallback overflows — and it does so at **both** 2048 and 4096, for every
request that can produce a file (a three-page-website request measures 3,102; with
search+images+sub-agent appends enabled every artifacts request exceeds 3,800). On a
2048-window model the entire artifacts surface of the app is dead.

### Real-token check (gemma-3-1b-it Q4_0 GGUF, GenieX server, `usage.prompt_tokens`)

| prompt | app estimate | real server | error |
| --- | --- | --- | --- |
| failed chat prompt | 3,075 | 2,494 | +19% (over-counts) |
| planner prompt | 791 | 721 | +9% |
| plain request | 14 | 16 | −2 (template overhead) |
| greeting | 7 | 11 | −4 (template overhead) |

The estimator is rough (±10–25%): conservative on long prose, slightly under on tiny
prompts (chat-template overhead it does not model). It never under-counts a long
prompt, so budgets built on it are safe against real overflow — but it refuses
requests that would actually fit, which is exactly what happened here.

### How much instruction text a model can use before answers get worse

Probed on the installed 1B (GenieX, CPU server): a fixed 3-line format task was asked
with a growing instruction preamble. Compliance fell from 2/2 with no preamble to 0/2
at ~940 real instruction tokens, 1/2 at ~1,900, 0/2 at ~2,500 (runs are noisy on a
1B; the direction is consistent). The full system prompt (~2,500 real tokens) is
**beyond the useful instruction budget of the smallest installed model even when it
fits the window**. This matches the prompt-lab findings already recorded (a 2B fails
the calc-sheet steps; the 4B series needed the engine's own instructions, not more
text). Design conclusion: the instruction budget must shrink with the window, and
irrelevant blocks must go even on big windows — for small models they cost quality,
not just tokens.

## The design

Two approaches were considered.

### Approach A — a budgeted prompt assembled from registered, prioritized blocks (recommended)

Every instruction block becomes a **named entry in one registry** with:
a **priority** (what goes first when room runs out), a **relevance rule** (which
kinds of request may need it — decided only by an already-chosen route or by the
closed questions in `Q` in `src/core/router.ts`, never by word lists or message
length), and a **measured token cost** (by `tokensOf`, the app's own counter).

Assembly, on every route that sends a request:

1. Measure the conversation and the question with the app's own counter, after
   `fitMessages` has done its normal work on history and files.
2. The **instruction budget** is whatever is left of the request budget
   (window − reply reserve − conversation − question), with a floor at the minimal
   core and a ceiling at a share of the window (so instructions never crowd out the
   answer on any size).
3. Start from the **minimal core** (who is speaking, the artifact format, the edit
   blocks — about 400 estimated tokens). Then add blocks in priority order while
   they fit the budget and their relevance rule says this request may need them.
   When room runs out, the **lowest-priority relevant block is dropped whole**
   (never cut mid-sentence — a cut rule is worse than no rule).
4. If even core + question does not fit, fail honestly with a message that names the
   real sizes (see rule 7 below).

Consequences:

- The chat route can never refuse because of its own text: if the full prompt does
  not fit, instructions drop (office 813 → drawn-blocks 670+405 → visual overview →
  artifact extras) down to the 400-token core before anything is refused. Hello
  world at 4096 sends core-only (~600 tokens with the question) and reaches the
  construction engine as a "new" one-file build via the direct plan — or, if the
  questions fail, the fallback chat route with the same budgeted prompt answers.
- Any `handled:false` fallback (planner failure, deck no-plan, calc-sheet → free
  file → chat) re-enters the chat route, which now **budgets its own prompt the same
  way**: a fallback can never exceed the budget, because nothing that assembles a
  request is allowed to skip the registry.
- A failed build step is shown: when `stepwise` gives up (planner unusable, or a
  stream error), the chat route first sends a visible notice ("Planning did not
  finish: <reason>. Answering directly.") instead of silently switching routes, and
  the replies to the closed questions are written to the log (today the "several
  files?" answer is not recorded anywhere).
- The served window becomes **the one number**: the sidecar always reads the
  host-reported served window (already returned as `servedNctx`), and the
  `?? entry.recommendedContext` fallbacks in helper routes and the renderer's meter
  are removed. The host logs, at serve start, the chosen window **and the reason**
  ("explicit request", "kept load profile", "QAIRT compiled", "RAM tier default —
  model recommends 16384"). A new chat-log line records window + reason + the
  section sizes of every refused-or-trimmed request.
- The overflow notice is rewritten to name the parts: "The model's window is 4096
  tokens; the app's instructions took X, the conversation Y, your question Z."
  Advice is only "shorten your message" when the question itself is what does not
  fit; otherwise the advice is "start a new chat" or "choose a model with a bigger
  window".

What does **not** change (decided rules respected): every program still goes through
the construction engine whatever the request length — this design touches only what
the *instructions* say, never the routing decision; the closed questions in `Q`
decide relevance exactly as routing does today; no small-request shortcut is
brought back.

### Approach B — two fixed prompts per route (full/lean), chosen by route

Each route gets a hand-written lean prompt (core only, ~400 tokens); the heavy
blocks stay only in the routes that truly need them (the deck planner keeps its
rules; the chat route never gets office specs). No runtime measuring, no registry —
simpler and predictable.

Why it loses: it cannot react to the window (a 2048 model still gets everything the
route's lean prompt + a long conversation implies, and the deck's 1,224-token planner
prompt stays on a 2048 window); every future block needs a hand decision in two
places; and it does not guarantee rule 1 — the guarantee "the person's message always
fits" needs a measured budget somewhere, and doing it per route by hand is where the
drift crept in the first time. Approach B also cannot drop blocks by priority as the
conversation grows; it only moves the cliff.

### Risks of Approach A, and their answers

- **A dropped block changes behavior at the edges** (e.g. a chat answer that
  spontaneously produces a Word file without the xlsx rules). Answer: the minimal
  core keeps the artifact + edit format always; the deep per-kind specs (office
  internals) are what gets dropped, and a request whose route is a build/template/
  deck never drops its own rules — only the chat fallback does.
- **The relevance question can mis-answer** (router says "not a document" for an
  ambiguous request). Answer: when no model answers the closed question, blocks are
  **kept** (inclusion is the default); dropping only happens on a clear answer or
  when the budget forces it.
- **Estimator error (±10–25%)** could let a real request overflow after all.
  Answer: the reply reserve stays, the budget is computed on the estimate that never
  under-counts long text, and `streamComplete`'s existing overflow squeeze
  (`isContextOverflow` → refit) remains the last resort. The real `usage.prompt_tokens`
  the server returns is now logged, so drift becomes visible.
- **Blocks already carry implicit references to each other** (e.g. the drawn-blocks
  line assumes the block rules). Answer: the registry records dependencies; a block
  is never included without the blocks it depends on, and never dropped while a
  dependent block is kept.
