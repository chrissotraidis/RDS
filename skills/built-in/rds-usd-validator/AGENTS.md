# rds-usd-validator

Use this skill for game-asset-pipeline, web-3d, and any build that outputs or transforms USD, glTF, GLB, meshes, textures, scenes, or downloadable 3D assets.

Implementation contract:
- `spec/target_spec.yaml` when present.
- Otherwise the PRD section describing asset formats, scale, polygon budget, materials, animations, and preview requirements.

Expected build artifacts:
- A generated or transformed asset under the build/app artifact directory.
- A preview route or static preview image when possible.
- A validation report naming the validator used and the asset path checked.

Verification:
- For glTF/GLB, run Khronos glTF Validator when available.
- For USD, run available OpenUSD tooling when installed.
- If validators are missing, emit an explicit pending validation note and still inspect file existence, size, and previewability.
- Check the browser preview for nonblank rendering when the asset is meant to be viewed.

Sources:
- OpenUSD tools: https://openusd.org/release/toolset.html
- Khronos glTF Validator: https://github.khronos.org/glTF-Validator/
