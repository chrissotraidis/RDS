# gltf-validator-skill

glTF/GLB validation expectations for game asset pipeline outputs.

Applies to: game-asset-pipeline
Category: asset-pipeline
Maturity: stable

Use when:
- The selected stack is `game-asset-pipeline`.
- The build generates, transforms, validates, or serves GLTF/GLB assets.

Implementation contract:
- Keep input, processed output, validation report, and preview artifact paths explicit.
- Run validation on every generated GLTF/GLB artifact before handoff.
- Treat structural validator errors as blockers; warnings require written triage.
- Preserve asset metadata that matters for downstream engines: scale, units, materials, textures, animation clips, and license/source notes.

Verification:
- Run the validator or the stack's asset validation command.
- Save a JSON or text validation report in build artifacts.
- Open a browser preview for at least one validated asset.
- Record blockers for missing textures, invalid buffers, broken materials, or oversized files.

Source references:
- glTF Validator: https://github.khronos.org/glTF-Validator/
