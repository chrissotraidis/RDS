# playwright-mcp

Browser-level verification contract for real preview interaction.

Applies to: universal
Category: testing
Maturity: operational

Use when:
- Any user-facing preview claims controls, navigation, rendering, forms, gameplay, or workflow behavior.
- RDS needs evidence beyond HTTP 200, unit tests, or static screenshots.

Implementation contract:
- Open the generated preview in a browser and exercise the primary user journey.
- Click real controls, links, buttons, form fields, canvas/game controls, or extension preview controls depending on the stack.
- Save evidence paths for screenshots, console errors, transcripts, and scenario verdicts.
- Treat no-op controls, broken links, console errors, blank canvases, and mobile overlap as blockers.
- Keep verification stack-appropriate: page flows for websites/apps, canvas interaction for games/3D, popup/options preview for extensions, mobile viewport for native previews.

Verification:
- Run the relevant Playwright/browser check.
- Confirm the primary flow changes visible state or reaches the expected route/state.
- Check browser console output.
- Write blockers in QA artifacts so `rds-fix` and the dashboard can act on them.

Sources:
- Microsoft Playwright MCP: https://github.com/microsoft/playwright-mcp
- Playwright: https://playwright.dev/
