# Indexing Contract

The index exists to help another agent find the right wiki page without reading the whole wiki.

## Outputs

The indexing script should maintain:

- `index/wiki-index.json`: structured retrieval data
- `index/wiki-index.md`: concise human-readable directory

## Required fields for each entry

- `path`: path relative to the wiki root
- `title`: primary document title
- `section`: high-level area such as `product`, `design`, `engineering`, `operations`, or `review`
- `headings`: secondary headings found in the file
- `summary`: short description derived from the file content
- `keywords`: discoverability terms based on headings, path, and repeated meaningful tokens
- `completeness_score`: page completeness (0-3), used for spec-readiness checks

### Completeness scoring

| Score | Label | Criteria |
|---|---|---|
| 0 | Empty | Page has only the template heading, no substantive content |
| 1 | Stub | Some content exists but mostly gaps and open questions |
| 2 | Partial | Has confirmed and inferred content, some gaps remain |
| 3 | Complete | All sections filled, no critical gaps, sources cited |

Scoring rules:
- A page with only `## Purpose` filled is a 0 (template only)
- A page with `## Confirmed` empty but `## Gaps` populated is a 1
- A page with content in `## Confirmed` and `## Inferred` but open gaps is a 2
- A page with all sections substantive and no unresolved critical gaps is a 3

## Retrieval expectations

Another agent should be able to:

- find where a feature, flow, role, or integration is documented
- discover open questions and known gaps quickly
- see which pages are likely to contain UX or engineering context
- map common terms to the most relevant page in one pass

## Spec-readiness summary

The index should include a top-level `spec_readiness` object:

```json
{
  "spec_readiness": {
    "ready": true,
    "overall_score": 2.3,
    "product_average": 2.6,
    "empty_pages": [],
    "blocking_questions": 0,
    "core_pages": {
      "product/overview.md": 3,
      "product/features-and-capabilities.md": 2,
      "product/journeys-and-flows.md": 2,
      "engineering/data-and-entities.md": 2
    }
  }
}
```

This is primarily used by greenfield workflows to determine when the wiki
has enough content for spec formalization. Brownfield wikis populate it too
but do not gate on it.

## Index quality checks

If retrieval quality is weak:

- improve page titles
- improve the first paragraph of important pages
- add clearer headings
- rename ambiguous files
- rebuild the index

The index is not a search engine replacement. It is a fast navigation layer for agents.
