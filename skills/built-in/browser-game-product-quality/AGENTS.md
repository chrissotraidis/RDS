# browser-game-product-quality

Product, UI, visual-direction, and game-feel contract for browser-playable games.

Applies to: game-engine
Category: game
Maturity: beta

Use when:
- The selected stack is `game-engine` and the runtime is the built-in HTML5/browser game stack.
- The PRD describes a board game, abstract strategy game, arcade game, puzzle game, canvas game, or browser-playable game.
- The build needs to feel like a designed game product, not a mechanics test harness.

Implementation contract:
- Start from a clear product stance: genre, table/screen metaphor, visual tone, primary play surface, and one memorable hook.
- Design the first viewport around the game surface. Avoid admin-dashboard shells, generic beige panels, nested cards, and documentation-heavy copy.
- For board and strategy games, make the board large, tactile, and legible; show selected piece, legal moves, captures, turn, score/victory pressure, history, and restart without crowding the play surface.
- For arcade/action games, make input feel immediate; show impact, risk, scoring, difficulty progression, game-over, and instant restart.
- Build responsive controls deliberately. Mobile must have a stable play surface, reachable controls, no horizontal overflow, and no text/control overlap.
- Add stateful feedback for every core action: hover/focus, selection, legal/illegal move, capture/hit, win/loss, AI thinking, and restart.
- Use assets, texture, motion, lighting, sound hooks, or custom drawing where useful. Do not rely on plain HTML boxes unless the visual system intentionally supports that choice.
- Keep the technical core simple enough to verify. Product quality is not a reason to skip deterministic engine tests.

Verification:
- Run the app in a real browser and interact with the full loop: start, play several turns/actions, observe feedback, reach or expose win/loss/restart, and restart.
- Capture desktop and mobile screenshots of the main play surface.
- Verify the board/canvas is nonblank and visually dominant in the first viewport.
- Verify at least two different player inputs change meaningful visible state.
- For turn-based games, do not require passive state changes while idle; verify a visible idle/turn/AI-thinking state instead.
- Treat cramped mobile layout, generic dashboard styling, missing feedback, invisible legal moves, or no replay path as product-quality blockers even when unit tests pass.

Sources:
- Playwright screenshots: https://playwright.dev/docs/screenshots
