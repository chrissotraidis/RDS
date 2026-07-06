---
name: wiki-bootstrap
description: Scaffold a new product wiki from source artifacts. Creates the wiki directory structure, templates, and intake manifest.
---

# Bootstrap Wiki

Create the initial wiki scaffold from product artifacts.

## Usage

```bash
python3 scripts/bootstrap_wiki.py \
  --product-name "<product name>" \
  --output-dir <wiki-destination> \
  <artifact paths...>
```

Options:

- `--product-name`: product name used in wiki headings (required)
- `--output-dir`: destination directory for the wiki (required)
- `--force`: allow writing into an existing non-empty directory
- Positional args: artifact files or directories to catalog

## What it produces

- 20 templated markdown files matching the wiki blueprint layout
- `intake/source-manifest.md` and `intake/source-manifest.json` cataloging all inputs
- Each source entry captures: path, type, detected heading, and summary

## After bootstrapping

1. Review the generated `intake/source-manifest.md` to confirm all artifacts were captured
2. Begin filling in the template pages with actual product information from the artifacts
3. Use the page contract from `references/wiki-blueprint.md`: Purpose, Confirmed, Inferred, Gaps, Open questions, Sources
4. Run `/wiki:wiki-reindex` after substantial content changes

If the artifact quality is low, focus on the minimum viable wiki files first (see `references/wiki-blueprint.md`).
