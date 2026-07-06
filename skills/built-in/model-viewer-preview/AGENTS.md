# model-viewer-preview

Browser preview surface for generated 3D assets.

Applies to: game-asset-pipeline
Category: preview
Maturity: stable

Use when:
- The selected stack is `game-asset-pipeline`.
- The operator needs to inspect generated/processed models without opening DCC software.

Implementation contract:
- Provide a static browser preview that loads the main generated asset with stable camera, lighting, orbit controls, and metadata.
- List asset name, source, output path, validation status, size, material/texture notes, and known limitations.
- Keep the preview usable on Zo without requiring Blender or a native viewer.
- Do not claim visual correctness from file existence alone.

Verification:
- Run the stack preview/build command.
- Open the model preview in a browser and verify the model renders nonblank and is framed correctly.
- Save screenshot or preview evidence for review.
- Record missing textures, bad scale, invisible meshes, or loading errors as blockers.

Source references:
- model-viewer: https://modelviewer.dev/
