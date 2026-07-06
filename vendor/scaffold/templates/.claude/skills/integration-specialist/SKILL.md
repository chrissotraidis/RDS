---
name: integration-specialist
description: "Use when implementing integration, wiring, or cross-feature tasks. Provides patterns for connecting components, verifying navigation flows, and ensuring data consistency across features."
---
# Integration Specialist

You are working on an integration task. Every component must be wired end-to-end:
backend to frontend, list to detail, form to submission, job to trigger.

## Approach

1. **Inventory what exists.** Before building, check what prior tasks created: models,
   routes, views, seed data. Check the routing table and review the seed/fixture files.
2. **Wire both directions.** If page A links to page B, verify both: the link on A
   exists AND page B loads correctly when visited via `curl`.
3. **Test with seed data.** Every feature must work with seeded data. Don't rely on
   records created manually during implementation.
4. **Check client-side routing interactions.** If the framework uses partial page
   replacement (Turbo Frames, React portals, HTMX swaps, Next.js layouts):
   - Ensure links that should do full-page navigation are not trapped inside a partial
     replacement region (e.g., use `data-turbo-frame="_top"` in Hotwire)
   - Lazy-loaded partials return 200 and contain the expected container ID
   - Container/frame IDs match between source and target pages

## Quality Criteria

Before marking the task done, verify:

- [ ] All navigation links resolve to real pages (no `href="#"` placeholders)
- [ ] List items link to their detail pages and the detail page loads (`curl` returns 200)
- [ ] Forms submit successfully and redirect appropriately
- [ ] Partial-replacement container IDs match between source and target pages
- [ ] Data displays show real content from seed data (no blanks, no "N/A", no errors)
- [ ] Action buttons (edit, delete, export) trigger their intended actions
- [ ] Foreign key selectors (dropdowns, search fields) are populated with real options
- [ ] Error states show user-friendly messages (not 500 errors or stack traces)

## Verification Focus

When running verification commands, pay special attention to:
- HTTP responses containing expected content (`curl -sf <url> | grep -q "expected text"`)
- Navigation flows: can you follow links from list → detail → edit → back?
- Seed data consistency: does every data-dependent page display real seeded content?

## Common Pitfalls

- **Trapped navigation**: Links inside a partial-replacement region (Turbo Frame, HTMX
  target, React portal) try to replace only that region. Links intended for full-page
  navigation must escape the region (e.g., `data-turbo-frame="_top"` in Hotwire,
  standard `<a>` without `hx-target` in HTMX).
- **Dead navigation links**: Creating a nav link with `href="#"` as a placeholder.
  Every nav link must point to a real route from the first moment it appears.
- **Orphan backends**: Creating a job, service, or mailer without any UI trigger.
  If it can't be reached by a user, it doesn't exist from the user's perspective.
- **Seed data mismatch**: Feature X looks up a record by the current user's email
  but no seeded record matches. Always verify lookups against seed data.
- **Missing selectors**: A form has a foreign-key field but renders a text input instead
  of a dropdown populated with real related records.
