# shadcn-add

shadcn/ui component workflow contract for polished Next.js interfaces.

Applies to: nextjs-fullstack
Category: frontend
Maturity: operational

Use when:
- The selected stack is `nextjs-fullstack`.
- The app needs forms, navigation, dialogs, tables, menus, settings, cards, alerts, toasts, or dashboard/product UI.

Implementation contract:
- Use shadcn/ui components and local `components/ui/*` primitives instead of ad hoc HTML/Tailwind for standard controls.
- Keep `components.json`, Tailwind config, `lib/utils`, and generated components consistent.
- Design the primary workflow, not a decorative shell. Components must be wired to real state.
- Avoid nested-card layouts, placeholder metrics, oversized marketing composition inside tools, and controls that do not affect anything.
- Keep accessibility states and keyboard behavior for dialogs, menus, forms, and buttons.

Verification:
- Run the Next.js build/check command after components are installed.
- Open the preview and interact with the core shadcn-backed controls.
- Verify no import aliases, missing components, hydration errors, or unstyled controls.
- Treat raw ad hoc controls for standard UI as a design-system regression unless the PRD requires custom rendering.

Source references:
- shadcn/ui CLI: https://ui.shadcn.com/docs/cli
- shadcn/ui Components: https://ui.shadcn.com/docs/components
