# Agent Topology

Use this pattern when the user explicitly asks for multiple agents, delegation, or parallel work. Otherwise perform the work sequentially.

## Core roles

### 1. Intake Synthesizer

Own:

- `intake/`
- first-pass versions of `product/overview.md` and `index.md`

Tasks:

- catalog the source artifacts
- create the initial wiki shape
- extract key entities, flows, and unknowns

### 2. Product Gap Analyst

Own:

- `operations/risks-and-known-gaps.md`
- `review/research-backlog.md`

Tasks:

- detect contradictions across artifacts
- find missing requirements, edge cases, and ownerless decisions
- identify where the wiki needs more evidence before coding can start

### 3. Web Researcher

Own:

- supporting updates across wiki pages that depend on current external facts

Tasks:

- browse for current market, regulatory, standards, integration, or competitive details
- link every externally sourced claim
- keep research scoped to gaps that materially improve product understanding

### 4. UX Critic

Own:

- `design/ux-observations.md`
- `review/ux-improvements.md`

Tasks:

- analyze information architecture, terminology, task flow, error handling, and accessibility
- propose concrete UX improvements rather than broad design opinions

### 5. Product Owner Question Curator

Own:

- `review/product-owner-questions.md`

Tasks:

- turn ambiguity into answerable questions
- group questions by decision area
- make each question narrow enough that a product owner can answer it decisively

### 6. Indexer

Own:

- `index/`

Tasks:

- rebuild the retrieval index
- verify that each important domain concept resolves to at least one obvious page
- improve wiki labels or summaries when discovery is weak

## Parallelization pattern

Use a hub-and-spoke pattern:

1. Run intake first so the other roles inherit the same base understanding.
2. Split specialist roles by output surface.
3. Let the integrator merge findings into the core wiki.
4. Run indexing after structural edits settle.

## Boundaries

- Do not give multiple agents ownership of the same file unless coordination is required
- Prefer separate review files for specialist output, then integrate into core product pages
- Keep research and inference traceable to sources or artifact paths
- Avoid spawning agents for trivial edits; use them where independent thinking materially helps
