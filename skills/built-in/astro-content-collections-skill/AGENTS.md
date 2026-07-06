# astro-content-collections-skill

Content collection schema and routing conventions for Astro content-led builds.

Applies to: astro-thin-web
Category: content
Maturity: stable

Use when:
- The PRD describes blog posts, docs, changelogs, guides, case studies, resources, or structured editorial content.
- Content needs typed frontmatter, generated routes, author/date metadata, or collections by category.

Implementation contract:
- Use Astro content collections instead of ad hoc markdown globbing.
- Define the schema close to the collection config.
- Keep routes predictable: collection index, detail page, and at least one sample content item.
- Validate missing title/date/slug fields during build, not at runtime.
- Keep the preview static and inspectable on Zo.

Verification:
- Run the Astro check/build command when available.
- Open at least one collection index and one detail page in the browser.
- Confirm frontmatter errors fail clearly.

Source references:
- docs.astro.build: https://docs.astro.build/en/guides/content-collections/
