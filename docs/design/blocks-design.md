# Blocks design

This document describes the block architecture and its design decisions.
Implementation modules are listed in section 12.

## 1. Goal

A small model (Qwen3.5-4B on NPU, 13 to 20 tokens per second) must produce on the first try a working game or small application, in few tokens, without hallucinating format. It cannot be trained on our language. The only way is therefore to **bring our language closer to what it has already seen millions of times**, and to verify everything programmatically.

## 2. Golden rule: nothing new to learn

Every element of our language must have a known model. If an element has none, we change it or tolerate it under several spellings.

| Our element | What the model already knows | Gap |
|---|---|---|
| Layout, colors, animations | whole HTML and CSS (grid, flex, var(), classes) | none |
| One block = one tag | custom elements (`<mon-bloc>`) | only the block name is new |
| Setting a block | HTML attributes, `data-*` | none |
| Game state | variables, JSON object | names limited to `[a-z][a-z0-9_]*` |
| Effects (`gold += 1`) | JavaScript compound assignments | only `=`, `+=`, `-=`, `++`, `--` |
| Conditions (`hp <= 0`, `gold >= 3 && key`) | JavaScript comparisons | no function, no call |
| Map | roguelike text maps | ASCII characters only |
| Lists (inventory, quests) | `<template>` and `{name}` (Handlebars/Mustache-style templates) | none |
| Reaction to a click | `onclick` | we write `data-click="gold+=1"`: same idea, but no JavaScript executed |
| Screens | sections that are shown and hidden | `hidden` / `data-scene` |

Concrete consequences:

1. **Spelling tolerance.** The parser accepts `gold+=1`, `gold += 1`, `gold+1`, `gold++`, `+1 gold`. Everything is normalized internally. The model is never penalized for a neighbouring spelling.
2. **Known English words** for roles (`wall`, `door`, `exit`), events (`click`, `keydown`, `pickup`) and actions (`say`, `go`, `restart`).
3. **No syntax of our own**: no special semicolon, no braces of our own, no mini-language of rules. A rule is a tag with `when` and `do`, which looks like an `if` in two attributes.
4. **Unknown tag or unknown attribute**: the app suggests the closest one (`game-inventroy` → `game-inventory`) and corrects it itself when the gap is one or two letters. The message to the model only mentions the correction.

## 3. Architecture: seven layers, a single bridge

```
CSS / HTML (appearance, layout)               <- the model writes it as usual
        ^  state reflected in CSS variables, data- attributes, classes
        |  clicks / keys / input = effects
STATE (numbers, texts, lists, flags)          <- the only thing shared
        ^  effects (+=, -=, =)     v  events (pickup:key, hit:enemy)
BLOCKS (map, rules, timer, list...)           <- written by us, once
```

**Principle: logic never touches the DOM and the DOM never contains logic.** The bridge is the state.

### 3.1 State (`<x-state>`)
- Attributes = starting values: `<x-state hp="3" gold="0" name="Ana">`. A number stays a number, the rest is text.
- A value referenced by an effect but never declared is created at 0.
- A list is a state whose value is an array of objects: `<x-state items='[{"name":"key","count":1}]'>` (JSON, which the model knows).
- Changes notify only once per frame (never one notification per write), so that 60 frames per second remain smooth.

### 3.2 Effects and conditions: a single evaluator
- **Effect**: `name += n`, `name -= n`, `name = value`, `name++`, `name--`, plus a few actions: `say:"text"`, `go:scene`, `restart`, `win`, `lose`, `emit:event`, `add:list {…}`, `remove:list index`.
- **Condition**: comparisons, `&&`, `||`, `!`, parentheses, state names. No function, no DOM access, never `eval`.
- The same evaluator is used for legends, rules, the `data-when` and `data-click` attributes, and templates. A single format to know.
- Numbers are clamped if a `min`/`max` is given on the state (`<x-state hp="3" hp-max="3">`).

### 3.3 The bridges between state and page
**Logic to page (automatic, without writing anything):**
- each state number becomes `--name` on `<body>` and `data-name="…"`: CSS can write `width: calc(var(--hp) / 3 * 100%)` or `body[data-hp="0"] .hero { filter: grayscale(1) }`;
- a named true condition (`has-key` for `key >= 1`) becomes a class on `<body>` when it is declared by `<x-flag name="has-key" when="key>=1">`;
- `data-when="expr"` on any element shows or hides it;
- `<x-value of="gold">` inserts the state text;
- `<x-list of="items"><template>…{name}…</template></x-list>` repeats the template for each item.

**Page to logic:**
- `data-click="gold-=3 key+=1"` on any element;
- `data-key="Space: jump"` / `data-key="ArrowLeft: x-=1"`;
- `data-bind="name"` on an `<input>`, `<select>` or `<textarea>`: reading and writing state (for applications);
- `data-submit="add:items {name: {draft}}"` on a form.

### 3.4 Events
- Each block emits named events `verb:object` (`pickup:key`, `hit:enemy`, `open:door`, `talk:old-man`, `change:gold`).
- A rule listens: `<x-rule on="pickup:key" do="say:'A key!'">`.
- The engine briefly adds an animation class (`fx-pickup`, `fx-hit`) to the element concerned: the model attaches its CSS animations to it, without code.

### 3.5 Scenes
- `<x-scene id="ville">`: a screen. Only one scene is visible at a time (the others have `hidden`). The `go:ville` effect changes scene. State persists.
- A scene can have its own `<x-map>`, its own rules. Rules outside a scene are global.

### 3.6 The world (`<x-map>`)
- Text map, one-line legend per character: `<char> <role> [appearance] [effects] [needs:...] ["words"] [still]`.
- **DOM rendering** (CSS grid of tiles `div.tile.wall`, moving entities `div.enemy` placed by `grid-area`) up to about 1 500 tiles; beyond that, canvas with the same classes. Appearance is decided by the model's CSS (`.wall { background: … }`), `look` is only used for emojis.
- Camera: `view="15x11"` shows a window following the player.
- Roles: wall, floor, player, item, enemy, door, exit, npc, trap, switch. Each role has a fixed behaviour, described in the block sheet; effects apply on entry.
- Map characters: printable ASCII only (emojis are 2 columns wide and shift the grid). Emoji appearance goes in the legend.

### 3.7 Persistence
- `<x-state save="slot1">` saves the state in the page's local storage, loaded at startup. Useful for progression games and for applications.

## 4. Blocks as contracts

Each block is described by a **sheet** that serves four purposes: writing it, documenting it for the model, verifying it, testing it.

```
name       : x-inventory
reads      : a state list
writes     : nothing
emits      : nothing
listens    : change:<list>
attributes : of (required), item (template, optional)
children   : <template> optional
example    : <x-inventory of="items"></x-inventory>
errors     : of missing → "of is missing"; unknown of → "the list "x" does not exist"
```

What the model sees: the `example` line and the attributes of each block **used in this request**, never the whole set. What the app uses: everything else.

A block the library does not have: the model writes a **declaration** (states read and written, events emitted, effects) and not JavaScript. Last resort, after trying all existing blocks: an `<x-script>` free-code block, executed in a sandbox (iframe without outside access) with its sheet and its test.

## 5. A single engine for games and applications

The core (states, effects, events, templates, scenes, persistence, input) says nothing about games. What is specific to games or applications lives in **block packages**:

| Package | Content | Usage |
|---|---|---|
| core | state, value, list, when, click, key, bind, rule, scene, save | everything |
| world | map, legend, entities, camera, tile collisions | RPG, dungeon, puzzle, roguelike |
| arcade | the current `Game.run` engine, seen as an `<x-arcade>` block with its description | pong, flappy, shoot'em up |
| app | calc (computed values), table, form, tabs, timer, sort/filter | to-do list, budget, converter, tracker |
| graphics | art (imported resources), theme, animations | everything |

A simple application is expressed with the same language:

```html
<x-state save="todo" tasks='[]' draft="">
<form data-submit="add:tasks {title: draft, done: false} draft=''">
  <input data-bind="draft" placeholder="New task">
  <button>Add</button>
</form>
<x-list of="tasks"><template>
  <li data-click="toggle:tasks.{index}.done">{title}</li>
</template></x-list>
<p data-when="tasks.length == 0">Nothing to do.</p>
<x-calc name="open" value="count(tasks, done == false)"></x-calc>
```
The prefix must be neutral (`x-`, not `game-`), since the same tags serve applications. The legacy `game-*` tags remain accepted as aliases.

## 6. Does generalizing lose game quality?

Honest answer: **yes, if we are not careful, and nothing is measured.** The real risks:

1. **Feel** (physics, timing, "juice"): a generic engine makes it average. Countermeasure: the *arcade* package keeps its dedicated loop; the core never does physics.
2. **Mechanics specific** to a game: a combat or crafting system may not fit the map roles. Countermeasure: specialized packages added as needed; as a last resort the `x-script` block.
3. **The language level**: if everything goes through effects, a very original game can become verbose. Countermeasure: the model can declare a new block composed of existing effects.
4. **Uniformity**: all games look alike. Countermeasure: appearance is free CSS and imported resources; only the mechanics are shared.
5. **The limit of a small model**: the more blocks are available, the more it can choose wrong. Countermeasure: it is only shown the blocks relevant to its request (chosen by words, then by the router).

The test to decide: for each package, a bench of ten typical requests, played automatically (section 9), with the first-try success rate, before and after each addition to the core. A drop in success or playability blocks the addition.

## 7. Where it can break (and what catches it)

| # | Breakage | Catch |
|---|---|---|
| 1 | Invented tag or attribute | closed list, one- or two-letter correction, otherwise a short message |
| 2 | Badly written effect (`gold + 1`, `gold++`) | tolerant parser, normalization |
| 3 | `<` or `>` in an attribute (`hp<=0`) | accepted by HTML; the validator reads the raw text and not only the DOM |
| 4 | Reference to nothing (state, scene, list, event) | cross-validator before display, with "did you mean…?" |
| 5 | Irregular map, tabs, wide characters | indentation normalization; emojis in the map refused with the correction |
| 6 | Map impossible to win (locked door without key, key behind a wall) | **verified on the text** by a traversal (BFS) without a browser: exit reachable, keys before doors |
| 7 | State names invalid for CSS (`Gold Count`, `hp-max`) | names limited and corrected (`gold_count`), CSS alias |
| 8 | Overlapping or off-screen elements | text layout report (ASCII plan, boxes, alerts) sent back to the model |
| 9 | Simultaneous writing of several states by several blocks | a single writer per frame, fixed order (rules in document order) |
| 10 | Very large page, slowed down | DOM map limited, canvas beyond, batched updates |
| 11 | The model writes a `<script>` | refused, with the expected form; sandbox only if requested |
| 12 | Truncated response or incomplete page while writing | the page only starts once complete; the existing resume continues |
| 13 | Multiple files: a block referenced in one file, defined in another | contract read from the code (like ids and classes today), verified |
| 14 | Context too large | sheets per used block, short steps (section 8) |
| 15 | Unreliable execution | no `eval`, our own evaluator, sandbox for free code |

## 8. Writing steps for a small model

A short session per step, which only sees the **interface** (the names) of the previous steps:

1. **Plan** (no call if the request is simple): useful packages, list of states, events, end conditions.
2. **State and rules**: `<x-state>`, `<x-rule>`, flags.
3. **World** (if a world package is used): legend and map, with the names from step 2.
4. **Layout and appearance**: HTML and CSS with the list of names (states, roles, events) and the style sheet decided in step 1.
5. **Missing blocks**: declarations, one per block.
6. **Verification and repair**: validator, map traversal, layout report; each problem returned in one sentence.

Target budget per step: about 2 000 tokens read and less than 1 000 written. A complete dungeon game on one page: about 900 tokens written, i.e. 45 to 70 seconds at 13-20 tokens per second (estimate, 3,3 characters per token).

## 9. Verifications without a model

1. **Text reading** (`blocksFlaw`): map shape, legend, references.
2. **Map traversal** (BFS): player, exit, keys, doors, required items.
3. **Scripted execution** in Chromium: the found path is replayed, the final state is compared (victory reached).
4. **Layout report**: ASCII plan, boxes, overlaps, overflows.
5. **Bench**: ten typical requests per package, with first-try rate, duration, tokens. This is the measurement to look at before expanding the core.

## 10. Design decisions

1. `x-` prefix; `game-*` tags remain aliases.
2. The attributes `data-click`, `data-when`... and their short forms are accepted; `data-*` is documented.
3. Map in DOM up to about 1 500 tiles, canvas beyond.
4. **A block that does not exist can be created, but not lightly.** Before letting the model write a block, the app asks it the question firmly, several times, with a definition of "exist": a block exists if there is a known tag that produces this behaviour with attributes (even with other settings), or if two existing blocks combined (states, events, rules) produce it. It answers with the name of an existing block, or with "none" and the reason. Two matching "none" answers out of three tries are needed to create; otherwise, we rewrite with the closest block. A created block is a declaration (states, events, effects), never free code, except as a last resort in a sandbox.
5. No visual block editor: the goal is that a single message produces a complex and complete game (a Mario-style level, a Pokémon-style RPG), by splitting the tasks well.

## 11. Breakdown for a complex game (Mario-like, RPG-like)

The block packages deliver the mechanics; the model composes:
- **Mario-like**: `platformer` (physics, stompable enemies, blocks, flag, camera) + `x-state` (score, lives, coins, `big`) + rules (`lives<=0` → lose) + `x-timer` (time) + scenes (menu, level 1, level 2) + CSS (HUD, title).
- **RPG-like**: `map` (towns, routes, tall grass, houses via `warp`) + `dialog` (NPCs, choices, quests via state) + `battle` (encounters triggered by `trap` tiles that emit `battle:...`) + `x-list` (inventory, party) + `x-calc` (stats) + save.
- A level or a map fits in 30 to 60 lines of text; a complete request is written in short steps (section 8), each step only seeing the names from the previous ones.
- Exact copies of the original games are not aimed at: the mechanics, yes, with visuals and names specific to the produced game.

## 12. Implementation

- Core and seven blocks written and tested in Chromium (`src/core/xblocks/`, scripts `scripts/xblocks-smoke/`), generated runtime (`xblocks.generated.ts`).
- `xcheck.ts`: text verification, map traversal, automatic repairs (`xMend`). `xplan.ts`: plan reading, default plan, names, replacement of approximate names (`mendNames`). `xbuild.ts`: construction in steps. `xdocs.ts`: what the small model reads from each block.
- **Drawn objects:** the plan lists lines `ART: name | LxH | description`; one call per object (the drawer only sees that object, its size and the CSS variable palette); the SVG is cleaned; the main model places the object by its name. Not done yet: finding an object by a search and modifying it alone ("make the pipe red") in the modification flow.
- Not yet measured with the real model: number of calls, real duration, first-try rate.
