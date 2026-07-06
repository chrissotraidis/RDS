# godot-scene-scaffolder

Godot scene and autoload scaffold contract.

Applies to: game-engine
Category: game
Maturity: beta

Use when:
- The PRD describes a playable loop, Godot project, scene tree, autoload singleton, player/controller behavior, levels, score, or exported web game.

Implementation contract:
- Name the main scene and autoloads explicitly.
- Keep game state, input mapping, scoring, and reset/restart path inspectable.
- If RDS generates a web fallback, it must still represent gameplay controls and state.
- Document generated scenes, scripts, assets, and export target.

Verification:
- Run available Godot/headless checks when installed.
- For web preview, confirm the canvas is nonblank and at least one interaction changes visible state.
- Capture a screenshot or short report showing the playable loop.

Source references:
- docs.godotengine.org: https://docs.godotengine.org/
