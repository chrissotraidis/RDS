# RDS Design Language

The dashboard is a **precision instrument panel**: a calm, dark operator console
where state is legible at a glance and the interface itself stays quiet.
Every UI change should be checked against the thesis and principles below.

## Thesis: state, reason, next action

Every screen answers three questions, in this order and in this place:

1. **What state is it in?** One status word, colored by meaning (green live or
   healthy, amber waiting or attention, red broken, neutral everything else).
2. **Why?** The concrete reason in plain words, taken from evidence: the error
   line, the stalled stage, the missing file. Never a generic hint such as
   "Open the app or inspect logs."
3. **What is the one next action?** A single filled button. Everything else on
   the view is quiet.

On a build page all three live in the **Build status** card, which is the only
place that may carry the primary action. Banners below it may explain more,
but they never repeat its buttons, and nothing essential may live only in a
banner (phones hide banners).

### Truth rules

The dashboard is trusted to decide whether a build is good, so it must never
look more certain or more alive than the evidence:

- **No invented facts.** If a value is unknown, say "Unknown" or show nothing.
  Do not fill gaps with defaults ("rails · green · claude") that read as data.
  An unreadable `state.json` is a visible state ("State unreadable").
- **No false liveness.** "Streaming", pulsing dots, and green timers appear only
  while something is running. An open connection to an idle log is "idle".
- **No contradictions.** A failed build never shows "No blocking evidence" as
  its only explanation; it shows the failure.
- **Quiet absence.** The normal case needs no label. Lists do not repeat
  "not hosted" on every row; they mark the rows that are hosted.
- **Same word, same classifier.** Hub, Builds, and build pages derive status
  words from one function (`statusKind`), so a build cannot be "Running" in
  one place and "Runner stopped" in another.
- **Clock skew is "just now".** Future timestamps never render as negative ages.

## Principles

0. **Dark only.** The console has one theme. There is no light or system
   mode to keep in sync; do not add a theme control without designing it.
1. **One material, one temperature.** Every surface comes from a single
   green-cast graphite ramp (`surface-container-lowest` → `surface-bright`).
   Never mix blue-gray darks with green darks. No ad-hoc hex values in markup —
   use the semantic tokens.
2. **Signal green is earned.** `primary-container` (#6ad7a3) means *live,
   healthy, or primary action*. It is never decoration. Amber (`tertiary`) means
   waiting or attention. Red (`error`) means failure. Everything else is neutral.
3. **Hierarchy from light, not boxes.** Prefer elevation steps (surface ramp)
   and typography over adding borders. Borders are hairlines that separate;
   they never decorate. If a panel reads as "wireframe", remove lines, don't
   add them.
4. **Typography does the talking.** Inter for UI. JetBrains Mono for
   identifiers, data, paths, and logs. Uppercase micro-labels
   (11px / 600 / +0.06em) for metadata. Sentence case for actions and titles.
5. **Density with air.** Operator tools are dense, but rhythm is constant:
   spacing on a 4px grid, 14–16px card padding, 8px radius on cards and
   controls, pills fully rounded.
6. **One loud button per view.** A single filled-green primary action. Every
   other action is quiet (bordered neutral). Destructive is red-tinted, never
   filled red unless confirming. "Stop" is never the green button.
7. **Motion is feedback.** 150ms ease on hover/focus only, and only on things
   you can click. Cards that are not links do not lift. The globe is the only
   ambient animation in the app.
8. **Every state is designed.** Empty states are one quiet line with an icon —
   never a boxed placeholder. Errors state what happened and the next action.

## Tokens (source of truth: `dashboard/tailwind.config.cjs`)

Tokens are precompiled into `dashboard/public/tailwind.css` (vendored; regenerate
with `bun run build:css` after changing markup or tokens). Non-Tailwind
component CSS still lives in `layout()` in `dashboard/src/server.ts`.

| Role | Token | Value |
|---|---|---|
| Page background | `background` / `surface` | `#0b0d0c` |
| Chrome (nav, topbar, footer) | `surface-container-lowest` | `#070908` |
| Inset panel / input | `surface-container-low` | `#101412` |
| Card | `surface-container` | `#141917` |
| Raised / hover | `surface-container-high` | `#1b211e` |
| Highest / chips | `surface-container-highest` | `#242b28` |
| Hairline border | `outline-variant` | `#242b28` |
| Muted label text | `outline` | `#75817a` |
| Body text | `on-surface` | `#e9eeea` |
| Secondary text | `on-surface-variant` | `#a5b0a9` |
| Signal green | `primary-container` | `#6ad7a3` |
| Green text/glow | `primary` | `#8beebb` |
| Warning amber | `tertiary` / `tertiary-container` | `#ffd9a0` / `#f0b869` |
| Failure red | `error` | `#ffb4ab` |

Fonts: `Inter` (UI) and `JetBrains Mono` (code/data), loaded in `layout()`.
Type scale: h1 22/700, h2 15/650, body 14, table 13, ribbon 12.5/600, code 12.5.

## Component rules

- **Cards**: `bg-surface-container` + hairline border + 8px radius + subtle
  top-light gradient (`.rds-hub-card` treatment). Header row: icon + title
  left, one status chip or link right.
- **Tables**: sticky header in `surface-container-low`, uppercase 11px column
  labels, 13px rows, row hover `surface-container-high`, hairline row
  separators at 50% opacity.
- **Chips/pills**: fully rounded, 11–12px, 600 weight, tinted bg at ≤10%
  opacity with matching text color.
- **Inputs**: `surface-container-low` bg, hairline border, 8px radius, focus =
  green border + soft ring, no browser outline.
- **Buttons**: primary = filled `#6ad7a3` with near-black green text; quiet =
  hairline border + `surface-container-high` hover; destructive = red tint.
  Height ≥ 34px, 8px radius, 600 weight labels. **Labels never wrap** —
  `white-space: nowrap` is part of the button contract.

## Layout contract

Breakpoint tiers. Every page must be deliberately designed at all five; "it
happens to render" is not designed:

| Tier | Width | Rules |
|---|---|---|
| Phone | ~390px | Sidebar behind hamburger. Single column. Tables become cards. Touch targets ≥ 40px. |
| Tablet | 768–1023px | Sidebar visible. Content single column or 2-up grids. No permanent secondary rails. |
| Desk | 1024–1279px | 2–3-up grids allowed. Secondary rails allowed only if the primary content keeps ≥ 640px. |
| Wide | 1280–1679px | Full layouts. Equal-height card rows may enforce min-heights here and up. |
| Max | ≥ 1680px | Content max-widths cap line lengths; no stretched full-bleed prose. |

- The primary content of a page (its table, log, or form) always wins space
  over navigation/filter chrome. A rail that starves the hero content at a
  given tier collapses into a toolbar or drawer at that tier.
- Never introduce a breakpoint change without checking the tiers on both
  sides of it.

## Page anatomy

Every page uses the same skeleton, top to bottom:

1. **Header**: eyebrow micro-label (muted, not green) → h1 (plain text, no
   icon, never signal-colored) → one-sentence purpose copy. Actions sit right
   of the header on one line (they wrap below the title as a group, never
   mid-label). At most one primary action. No "back to Hub" links; the sidebar
   is always there. Sub-pages may link to their parent (Settings).
2. **Toolbar** (optional): search/filters/controls for the hero content, one
   row, horizontally scrollable before it wraps chaotically.
3. **Hero content**: the reason the page exists. Tables, forms, logs.
4. **Secondary panels**: guidance, stats, reference. Always quieter than the
   hero — smaller, dimmer, collapsible where long.

Explainer/how-to content is secondary by definition: one compact strip, never
a grid of boxed cards competing with live data.

## Table contract

- Columns have priorities: P1 identity (never hidden), P2 state, P3 metadata.
  When space runs out, P3 columns drop first (or move into the identity
  cell), then the table transforms into cards (phone tier).
- Token columns (status, stage, time, money) never wrap; prose/tag columns
  wrap. Identity cells truncate with full value in `title`.
- A wide table scrolls inside its own container — the page never scrolls
  horizontally.
- Numbers that get compared (cost, counts, durations) use tabular numerals,
  right-aligned.
- Rows that navigate are keyboard-focusable (`tabindex`, Enter/Space) and get
  hover + `focus-visible` treatments.

## State templates

- **Empty (fresh install)**: one quiet italic line + a verb that starts the
  journey ("No builds yet — start your first build."). Never a boxed
  placeholder, never a wall of zeros, never raw route paths in prose.
- **Empty (filtered)**: say the filter is the reason and how to clear it.
- **Loading/streaming**: reuse the live-pill language (`● streaming`);
  skeletons are not used.
- **Error**: state what happened + the next action, in body copy, red-tinted
  panel. Raw error strings go in `<code>`, truncated.
- **Optional dependency absent** (e.g. Codex, tmux): neutral "not installed"
  chip, not a red "missing" alarm. Red is for things that are broken.

## Copy voice

Calm operator English. Sentence case everywhere except uppercase
micro-labels. No exclamation points, no marketing adjectives, no raw route
paths or env var names in prose (put them in `<code>` when needed).
Timestamps are humanized ("2h ago") with exact values in `title`. Actions are
verbs ("Approve", "Start goal"); statuses are humanized tokens ("Pending
review", never `pending_review`).
