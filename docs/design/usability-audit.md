# Usability audit and plain-language plan

Status: phase 1 (Projects, issue #61) implemented on branch
`ux/plain-language-projects`. Phases 2–4 (issue #62) are listed at the end
and are still open.

The goal: a first-time user with no technical background can understand,
set up and use MKMN without outside help.

## How the app was audited

Each screen reachable from the navigation rail was read in its source
(`src/renderer/*.tsx`) and, for the Projects screen, compared with the
screenshots users reported as confusing. Every visible string, placeholder,
tooltip, `aria-label` and error message was checked against the rules below.

## Writing rules (apply to all new and changed copy)

1. Say what the person can do or what will happen, not how the app works inside.
2. No internal words on everyday screens: *token*, *index*, *context window*,
   *sidecar*, *endpoint*, *quant*, *GGUF*, *inference*, *RAG*, *embedding*.
   They may appear only inside sections labelled **Advanced** or **Technical**.
3. No idioms or metaphors ("rides with every message").
4. Sizes people can picture: pages and words, or a percentage of a limit.
   Never two different units for the same thing on one screen.
5. Buttons are verbs that name the thing: "Add files", "Choose folder",
   "Try again". A bare "Add" or "Choose" only when the card title already
   says what.
6. Errors say what happened, then what to do next, in one or two sentences.
7. Confirmations name the thing, say what is kept and what is lost, and say
   when something cannot be undone.
8. Every input has a visible label or an `aria-label`; placeholders are
   examples, never the only label.
9. Sentence case for headings and buttons.

## Glossary (one name per idea)

| Idea | Use | Avoid |
| --- | --- | --- |
| Documents you give a project | **Reference files** | Files (clashes with the Files page), knowledge |
| Things the assistant made for you | **Files** (the Files page) | Artifacts |
| Preparing big files so the right parts can be found | **Preparing your files** | Building the search index |
| Text the assistant reads at once | **What it can read at once** | Budget, context, tokens |
| A folder the assistant may read | **Linked folder** | Folder |
| Hide without deleting | **Archive** / **Restore** | — |

## Findings

Severity: **High** blocks understanding of a core task; **Medium** slows or
misleads; **Low** polish.

### Projects (reported screens)

| # | Finding | Sev | Change |
| --- | --- | --- | --- |
| P1 | Meter reads "139k / 5k" with a full bar. Looks like an error; the unit is not stated. | High | Show a meter only while everything fits, labelled as a percentage. When it does not fit, say in words that the assistant looks up the matching parts. |
| P2 | Size units disagree: the meter counts characters, each file counts "~39763 tokens". | High | One unit people know: pages (when known) and words. |
| P3 | "Search index: ready — the question-by-question search reads from it." | High | "Your files are ready." Status only shown when it matters (files too big to read whole), plus "Try again" on failure. |
| P4 | "All of it rides with every message in this project." | Medium | "The assistant reads all of it in every chat in this project." |
| P5 | Card titled "Files" while the rail's "Files" page holds the assistant's output. | Medium | Rename the card "Reference files". |
| P6 | "44 sections" is an internal unit. | Low | Removed. |
| P7 | Folder: "It never changes anything." is ambiguous (changes what?). | Medium | "It can open and read files there, but never changes or deletes them." Button "Choose folder". |
| P8 | Description, note title, note text and instructions inputs have no label for screen readers. | Medium | `aria-label` on each. |
| P9 | Delete confirmation does not say it cannot be undone. | Medium | Names what is kept, what is lost, and that it cannot be undone. |
| P10 | "Recents", "Made here" are vague. | Low | "Chats in this project", "Made in this project". |
| P11 | Pin and Archive in the header have no explanation. | Low | Tooltips: what each does and that Archive can be undone. |
| P12 | "Or paste a note" with a "Title" field. | Low | "Paste text instead", "Title (optional)". |
| P13 | File errors are technical ("not a text file"). | Low | Name the kinds of file that work. |

### Other screens (to do in later phases)

| # | Screen | Finding | Sev |
| --- | --- | --- | --- |
| S1 | Rail | "Skills" opens personal instructions (Customize), while skills proper live inside it. The label does not match the page's first content. | Medium |
| S2 | Skills / Customize | Intro mentions "context window" and "small model reads only the first". | Medium |
| S3 | Settings | Section names such as "Speculative decoding", "KV cache", "GenieX runtime", "Local endpoint", "Execution verification", "NPU memory plan" sit next to everyday options. Most are already under *Advanced* or *Developer*; the remaining ones (Memory use, Conversation length & cache, Model loading) need plain names and to move under Advanced. | High |
| S4 | Local Models | Fit notes use "quant", "context", "fit rules", "compute target". | High |
| S5 | Tasks | "Prompts the assistant runs … using your NPU. Results and any artifacts land here." | Medium |
| S6 | Status pill | "AI status unavailable — the status check keeps failing" gives no next step. | Medium |
| S7 | Setup screen | Needs a read-through with a first-time user; copy comes from a state machine. | Medium |
| S8 | Chat errors | `src/core/errors.ts` messages need the "what happened, what to do" pattern. | Medium |

## Validation from a first-time user's view

Walk-through of the Projects screen after the change, reading only the
screen:

1. *What is this page?* — The title and the one-line description field.
2. *How do I start?* — Type in the box, press **Start chat**. The line beside
   it says what the chat will use ("No files added: chats will use your
   instructions only").
3. *I added a 44-page PDF. Is that a problem?* — The card says it is too long
   to read all at once and that the assistant will look up the parts that
   match each question. No numbers to decode. While it is being prepared, the
   card and the start line both say so.
4. *What does the folder do? Is it safe?* — It reads, never changes or
   deletes.
5. *Can I undo deleting?* — The confirmation says no, and that chats are kept.

Pass criteria met for this screen: no internal terms visible, one unit,
every action named by a verb, every input labelled.

## Review rounds

Round 1 failed both independent reviews (code and UX). Fixed in round 2:

- A failed preparation showed "being prepared" on every file. Now only
  queued, preparing and changed files say so; covered by a render test.
- The raw error text from preparing could show internal words. It is never
  shown now; a known cause (too many files) is named in plain words.
- The delete confirmation read as if the folder on disk were deleted. It now
  says the folder and original files are not touched, and that chats,
  scheduled tasks and made files are kept.
- "No files added: chats will use your instructions only" was wrong with a
  linked folder or no instructions. Now "No reference files yet", with the
  folder mentioned when one is linked.
- The meter now says what the percentage is of, never shows 0% with a file in
  it, and the over-limit line says roughly how many words the current model
  reads at a time.
- Unsupported files (images, archives) get one clear message instead of "split
  it"; several failures at once are all listed; untitled notes are named by
  their first words; made files use the same kind names as the Files page.

Still open, moved to phase 4 (#62) because the helpers are shared with chat
attachments: `noPdfText` ("no selectable text (a scan?)… vision model") and
the `describePdfError` fallback ("error category: …").

## Phases

1. **Projects** — done in this branch (P1–P13).
2. **Settings and Local Models** — S3, S4.
3. **Skills, Tasks, Files** — S1, S2, S5.
4. **Errors, status and setup** — S6, S7, S8, and the shared PDF messages above.
