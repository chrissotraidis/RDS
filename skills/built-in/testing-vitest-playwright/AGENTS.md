# testing-vitest-playwright

Vitest unit/integration and Playwright browser-check contract for TypeScript web builds.

Applies to: nextjs-fullstack, astro-thin-web, web-3d, game-engine, browser-extension
Category: testing
Maturity: operational

Use when:
- The selected stack is a TypeScript browser-visible stack.
- RDS needs fast code-level tests plus real browser behavior evidence.

Implementation contract:
- Keep fast deterministic tests close to domain logic: engine rules, utilities, route handlers, component state, or extension helpers.
- Use Playwright for user-facing journeys: navigation, forms, controls, canvas/3D/game interaction, extension popup/options preview, and mobile viewport checks.
- Tests must verify meaningful behavior, not only render smoke.
- Preserve stack commands so RDS can run tests without special local state.
- Capture browser errors and scenario evidence where possible.

Verification:
- Run the stack test/build command.
- Run or add at least one browser check for the primary user journey.
- Verify failures are actionable: named step, expected behavior, actual behavior, screenshot or transcript.
- Treat no-op controls, blank canvas, broken route, and mobile overflow as test failures.

Source references:
- Vitest: https://vitest.dev/
- Playwright: https://playwright.dev/
