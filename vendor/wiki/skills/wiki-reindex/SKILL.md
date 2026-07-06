---
name: wiki-reindex
description: Rebuild the wiki retrieval index and improve discoverability. Use after content or structural changes, or when agents struggle to find the right wiki page.
---

# Wiki Index Maintainer

Read these references first:

- `references/indexing-contract.md`
- `references/wiki-blueprint.md`

## Rebuild the index

```bash
python3 scripts/build_wiki_index.py <wiki-root>
```

This produces:

- `index/wiki-index.json`: machine-oriented retrieval index
- `index/wiki-index.md`: human-readable lookup table

## Focus on

- Ambiguous page titles
- Weak opening summaries
- Headings that do not reflect the page contents
- Gaps between common search terms and page terminology

## Primary outputs

- Update page titles, summaries, and headings as needed
- Rebuild `index/wiki-index.json`
- Rebuild `index/wiki-index.md`

## Rules

- Improve structure before adding more content
- Make the wiki answer "where is X documented?" quickly
