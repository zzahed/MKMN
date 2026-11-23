# MKMN AI — Brand Guide

This guide describes the MKMN AI identity and how to apply it in the product.
The authoritative copy strings live in `src/shared/brand.ts` (re-exported by
`src/renderer/brand.ts`); status-derived copy whose wording must follow runtime
evidence lives beside the logic that verifies that evidence
(`src/core/settingsUi.ts`, `src/core/setupView.ts`) and is pinned by tests. The
logo masters live in `build/mkmn-*.svg`.

## Name

- **Public brand:** MKMN AI
- **Compact brand:** MKMN (tight spaces such as the tray, logs and buttons)
- **Pronunciation:** Makman

MKMN takes its name from *makman* (مَكمَن), the Arabic term used in the
petroleum industry for a **reservoir**. The brand metaphor is a reservoir of
knowledge and potential on the user's personal computer. The name's origin is
explained in English in Settings → About; the interface itself is English only.

The public-facing display brand is **MKMN AI**. Internal identifiers (the
`app.mkmn.desktop` app id, the `MKMN` executable and product name, the
`opennpu.*` storage keys that saved chats and layout live under, install paths
and user-data directories) are retained for compatibility and are not
user-facing branding. The window's bridge to the app is `window.mkmn`.

## Positioning and personality

**Positioning:** a personal AI workspace that uses local models to help people
think, write, and work with their knowledge.

**Personality:** grounded, capable, discreet, clear, and professional. MKMN AI
is built for professionals working with valuable or confidential information.
Its connection to the energy industry is subtle and thoughtful — a name and a
contour motif, never decoration.

**Voice:** short, useful sentences. Explain technical details when they help
the user make a decision. Avoid hype, forced slang, excessive geological
metaphors, and unsupported security promises.

## Taglines and campaign lines

- **Brand name:** MKMN AI | مكمن (مَكْمَن, the Arabic word for an oil
  reservoir: something valuable kept safe beneath the surface; MKMN AI is a
  private reservoir that stores, understands and retrieves personal knowledge
  on the person's own device). The brand stands for privacy, security,
  intelligence, independence and offline operation.
- **Primary tagline (use everywhere one line of brand voice is needed):**
  "Your Private Intelligence Reservoir."
- **Supporting message:** "Your Knowledge. Your Device. Your Control."
- **Product descriptor:** "Private AI that runs on your own PC."
- Offline claims stay true: AI processing and storage are on the device and need
  no cloud once a model is installed; downloads and the optional connected
  features (web search, pictures) use the internet and say so.
- Supporting campaign lines, reserved for welcome, About, and promotional
  surfaces — do not scatter slogans through working screens:
  - "Discover the knowledge within."
  - "Your computer. Your knowledge. Your MKMN."
  - "Depth of intelligence. Freedom to work offline."

## Logo — "The Reservoir"

The symbol is three simplified geological contour layers around a central
opening, with a small accent point at the deepest spot. It communicates depth,
knowledge, and discovery. It deliberately avoids oil drops, drilling rigs, AI
brains, generic shields, and imitation of any company's logo. The logo is a
proposed identity, not a claim of trademark clearance.

Variants:

| File | Use |
| --- | --- |
| `build/mkmn-mark.svg` | Symbol master, charcoal + brass (light surfaces) |
| `build/mkmn-mark-dark.svg` | Symbol master, limestone + brass (dark surfaces) |
| `build/mkmn-mark-mono.svg` | Single-color symbol |
| `build/mkmn-app-icon.svg` | Rounded teal tile with limestone mark (app icon master) |
| `build/mkmn-tray.svg` | Simplified tile for tray sizes |
| `build/mkmn-wordmark.svg` / `-dark.svg` | Horizontal lockup: symbol + monoline MKMN wordmark |
| `build/mkmn-wordmark-ai.svg` / `-ai-dark.svg` | Lockup with "AI" as secondary descriptor (light / dark backgrounds) |
| `src/renderer/public/mkmn-mark.svg` | Symbol copy shipped with the renderer |

- In the renderer, `LogoMark` (symbol) and `LogoLockup` (horizontal lockup) in
  `src/renderer/Icons.tsx` draw the mark from `src/renderer/logoGeometry.ts` —
  a GENERATED module (do not edit by hand; run
  `node scripts/generate-brand-assets.mjs`) so the renderer and the exported
  assets share one geometry source. Contour strokes follow `currentColor` and
  the accent point follows `--logo-accent` (brass token).
- **Intentional optical variants:** the tray artwork
  (`src-tauri/icons/tray.png`, `build/tray.png`) uses two thicker rings and a
  tile-backed, rounder-corner variant so it stays legible at 16–32 px on light
  and dark taskbars; the Square*Logo and StoreLogo renders multiply the mark's
  stroke width by 1.06 (slightly thicker, not thinner) to hold up at very small
  Windows surface sizes. These are deliberate, not drift.
- **Minimum sizes:** symbol at 16 px; lockup at 40 px tall (the About surface
  renders it at 42 px, verified in place).
- **Accessibility:** `LogoLockup` is decorative (`aria-hidden`, no
  `role="img"`); every surface that shows it names "MKMN AI" in adjacent
  visible text, so assistive technology never hears the name twice.
- **Clear space:** keep at least the width of the outer contour stroke (≈8% of
  the symbol size) free around the symbol; half the cap height around the lockup.
- Regenerate every asset with `node scripts/generate-brand-assets.mjs` (pure
  Node, no dependencies, no network). That script is the single authoritative
  source: the SVG masters, every raster (PNG/ICO/ICNS), and the renderer's
  `src/renderer/logoGeometry.ts` all derive from its one geometry definition.
- **Verified vs intended:** the visual checks behind this guide (lockup
  legibility at 42 px, small-size icon clarity, title-bar layout) were done in
  the browser mock and by pixel sampling of the generated rasters; the real
  Windows tray and installed-app rendering still deserve a look on a machine
  running the packaged app.

## Palette

| Token | Hex | Role |
| --- | --- | --- |
| Petroleum teal | `#123C3D` | Primary actions, light-theme accent, icon tile |
| Charcoal | `#172124` | Dark-theme surface, light-theme text |
| Limestone | `#F5F2EA` | Light-theme background, on-dark text, logo strokes |
| Deep mineral | `#10191B` | Dark-theme background |
| Warm brass | `#BE9455` | Emphasis only (logo accent point, stars). Never small text. |

These are starting tokens, not mandatory pairings. The shared theme tokens in
`src/renderer/styles.css` derive AA-contrast text and interactive colors from
them (the dark theme uses a lighter teal `#4EA8A2` for interaction states).
Light and dark themes are both maintained, with distinct hover, focus,
selected, disabled, warning, and error states.

## Typography

`"Segoe UI Variable Text", "Segoe UI", system-ui` with standard fallbacks.
No remote fonts or CDN assets. Monospace: Cascadia Code / Consolas stack.
Headings are prominent but restrained; body copy stays readable; technical
information and performance metrics keep a legible size and tabular alignment.

## Approved interface copy

English only in this phase. The core approved strings below live in
`src/shared/brand.ts` (re-exported as `src/renderer/brand.ts`); outcome-derived
copy (setup states, execution labels, the model-selection headings) is derived
from runtime state by pure helpers in `src/core/setupView.ts` and
`src/core/settingsUi.ts` and is pinned by tests — the interface does not claim
centralization beyond that. Refine surrounding copy for consistency without
removing technical detail, consent information, or recovery instructions.

- Welcome heading: "Welcome to MKMN AI"
- Welcome description: "Think, write, and explore with AI running on your PC."
- Tagline: "Your Private Intelligence Reservoir."
- Supporting message: "Your Knowledge. Your Device. Your Control."
- Empty chat: "What would you like to explore?"
- Composer placeholder: "Ask a question or add a document…"
- Model ready: "Ready on this device"
- Empty chat, nothing selected and models installed: "Choose a model to get
  started." — the download wording, "Download a model to get started.", is
  shown only when the model inventory confirms no usable installed model
  (`noModelHeading` in `src/core/settingsUi.ts`; pinned by tests).
- Download explanation: "An internet connection is needed for this download."
- Verified local processing: "Processing on this device"
- Web action: "Search the web"
- Generation failure: "Couldn't complete the response. Try again."
- About story: "MKMN (pronounced MAK-man) takes its name from makman, the
  Arabic word used for an oil reservoir. Inspired by the value beneath the
  surface, MKMN helps you discover the potential in your own knowledge."
- Product explanation: "With a compatible model installed, AI processing runs
  on this PC. Model downloads and optional connected tools require an internet
  connection."
- Connected-features summary (nonexclusive — itemized detail lives in
  Settings → Web & privacy): "Optional connected features and downloads
  communicate with their selected services, and a connected search sends search
  terms derived from your conversation. Local inference runs separately on this
  PC, where your chats and documents are stored."
- Setup screen copy always follows the real outcome (consent, installing,
  failures, skipped components, ready) — derived by `setupOutcomeView` in
  `src/core/setupView.ts` (browser-safe), never asserted unconditionally.

Navigation keeps familiar names (Chat, Documents/Artifacts, Models, Tools,
Settings) that match existing functions; no geological renames and no entries
for features that do not exist.

## Privacy and offline claims — rules

- Distinguish local inference from downloads, web search, external tools, and
  configured remote endpoints. All chat completion in this app targets local
  (localhost) runtimes; web search, picture lookup and model downloads talk to
  the services the user enables in Settings → Web & privacy.
- Describe storage and derived queries accurately: conversations, documents and
  settings are stored on this PC and files are never uploaded — but web-query
  keywords are derived from the conversation, and user-message text parts
  include attachment text, so a connected search can carry words from attached
  documents. Say "derived from the conversation", never "nothing is sent".
- Disclose search-fallback recipients: with the no-key provider the same query
  goes to DuckDuckGo (html and lite pages) and, when neither answers, to
  Mojeek. The provider option and the "What leaves this PC" table both say so;
  never promise that only the selected provider receives the query.
- Show "Processing on this device" only when the runtime state supports it
  (a fresh, running generation on the local server) — never merely because the
  PC is offline or a local-sounding model is selected.
- Never claim "100% secure", "nothing ever leaves your device", or universal
  offline operation; never invent telemetry, encryption, compliance, isolation,
  or hardware-acceleration guarantees.
- Keep the measured / estimated / unavailable / stale distinctions in the
  resource meters intact.
- No decorative security badges or fake live indicators. Branding work must not
  introduce network calls, analytics, remote fonts, or tracking.

## Asset inventory

Generated from `scripts/generate-brand-assets.mjs` (single geometry source;
the renderer consumes the same geometry via the generated
`src/renderer/logoGeometry.ts`):

- SVG masters: `build/mkmn-mark.svg`, `build/mkmn-mark-dark.svg` (approved
  dark-background variant), `build/mkmn-mark-mono.svg`, `build/mkmn-app-icon.svg`,
  `build/mkmn-tray.svg`, `build/mkmn-wordmark.svg`,
  `build/mkmn-wordmark-dark.svg`, `build/mkmn-wordmark-ai.svg`,
  `build/mkmn-wordmark-ai-dark.svg`, `src/renderer/public/mkmn-mark.svg`
- Shared renderer geometry: `src/renderer/logoGeometry.ts` (generated — do not
  edit by hand)
- Windows icons: `build/icon.ico` (16–256 px; directory entries match payload
  dimensions), `build/icon.png` (512 px), `build/tray.png` (32 px),
  `src-tauri/icons/icon.ico`, `src-tauri/icons/icon.png`,
  `src-tauri/icons/32x32.png`, `src-tauri/icons/128x128.png`,
  `src-tauri/icons/128x128@2x.png`, `src-tauri/icons/tray.png`,
  `src-tauri/icons/Square*Logo.png`, `src-tauri/icons/StoreLogo.png`,
  `src-tauri/icons/icon.icns`
- Referenced by: `src-tauri/tauri.conf.json` (window title, bundle icons),
  `src-tauri/src/tray.rs` (loads `icons/tray.png` directly — the programmatic
  tray is the single tray owner; the `trayIcon` config block was removed so
  Windows never shows two icons), `installer.nsi` (installer icon, shortcuts),
  `package.json` `build.icon`/`build.win.icon`.

Asset integrity is pinned by `tests/brandAssets.test.ts`: ICO directory
dimensions must match their embedded PNG payloads, icon interiors must stay
opaque, and the renderer geometry must agree with the SVG master.

## Language and roadmap

The current interface is **English only**: navigation, buttons, settings,
onboarding, tooltips, status messages, errors, empty states, and accessibility
labels. No Arabic interface strings, RTL layout, Arabic fonts, language
selector, or localization framework ship in this phase. The core approved copy
is centralized in `src/shared/brand.ts` (kept out of graphics, no renderer or
Node coupling) so a future translation layer is straightforward; some
interface copy outside the brand strings is not centralized, by design.
Arabic interface localization may be added later as a
roadmap item; users can already enter, display, and generate Arabic or any
other language inside conversations and documents. MKMN AI is an independent
project, not affiliated with or endorsed by any company or organization; no
third-party logos or distinctive corporate identity elements are used.
