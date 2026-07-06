# RDS Design Language

The dashboard is a **precision instrument panel**: a calm, dark operator console
where state is legible at a glance and the interface itself stays quiet.
Every UI change should be checked against these principles.

## Principles

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
   filled red unless confirming.
7. **Motion is feedback.** 150ms ease on hover/focus only. The globe is the
   only ambient animation in the app.
8. **Every state is designed.** Empty states are one quiet line with an icon —
   never a boxed placeholder. Errors state what happened and the next action.

## Tokens (source of truth: `layout()` in `dashboard/src/server.ts`)

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
  Height ≥ 34px, 8px radius, 600 weight labels.
