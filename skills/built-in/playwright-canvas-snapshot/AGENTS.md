# playwright-canvas-snapshot

Canvas pixel and interaction evidence for WebGL, 3D, and browser-game previews.

Applies to: web-3d, game-engine
Category: testing
Maturity: stable

Use when:
- The generated app relies on `<canvas>`, WebGL, Three.js/R3F, or HTML5 game rendering.
- Visual correctness cannot be inferred from DOM text alone.

Implementation contract:
- Add or preserve a deterministic browser check that opens the preview, waits for render, samples canvas pixels, and saves screenshots.
- Verify nonblank output, stable framing, and a meaningful state change after interaction when the product is interactive.
- Test desktop and mobile viewports when the canvas is user-facing.
- Do not accept a passing build if the canvas is tiny, blank, offscreen, hidden behind UI, or visually static after required input.

Verification:
- Run the project build/test command.
- Use Playwright screenshot or pixel sampling evidence for the main canvas.
- Interact with the canvas or controls and verify changed pixels or changed visible state.
- Record the screenshot paths and any canvas blockers in QA artifacts.

Source references:
- Playwright screenshots: https://playwright.dev/docs/screenshots
