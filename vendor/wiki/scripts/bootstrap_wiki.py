#!/usr/bin/env python3
"""Scaffold a product wiki from source artifacts."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Iterable, List


TEXT_EXTENSIONS = {
    ".csv",
    ".json",
    ".md",
    ".markdown",
    ".rst",
    ".txt",
    ".yaml",
    ".yml",
}


WIKI_FILES = {
    "index.md": """# {product_name} Wiki

## Purpose

This wiki captures the current understanding of {product_name} from the supplied product artifacts.

## Start Here

- Review [intake/source-manifest.md](intake/source-manifest.md) for the input corpus
- Review [product/overview.md](product/overview.md) for the high-level summary
- Review [product/decision-log.md](product/decision-log.md) for accepted product decisions
- Review [operations/risks-and-known-gaps.md](operations/risks-and-known-gaps.md) for unresolved risk
- Review [review/product-owner-questions.md](review/product-owner-questions.md) for decisions still needed

## Sections

- Product: goals, users, journeys, features, roles
- Decision log: accepted product decisions and rationale
- Design: IA, UX observations, content, accessibility
- Engineering: behavior, data, integrations, analytics
- Operations: release, support, known gaps
- Review: UX improvements, research backlog, product-owner questions
- Index: machine and human retrieval artifacts
""",
    "product/overview.md": """# Product Overview

## Purpose

Summarize what {product_name} is, who it serves, and what outcomes it aims to produce.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "product/decision-log.md": """# Decision Log

## Purpose

Record accepted product decisions, why they were made, and which pages they affect.

## Entries

### DEC-001: Placeholder decision

- Status: draft
- Decision date:
- Decided by:
- Source question:
- Affected pages:
- Summary:
- Rationale:
- Follow-up:
""",
    "product/users-and-personas.md": """# Users And Personas

## Purpose

Describe the people, roles, and systems that interact with {product_name}.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "product/journeys-and-flows.md": """# Journeys And Flows

## Purpose

Document the main user journeys, system flows, branching behavior, and failure paths.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "product/features-and-capabilities.md": """# Features And Capabilities

## Purpose

Capture the feature inventory, important dependencies, and where feature behavior is still ambiguous.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "product/roles-and-permissions.md": """# Roles And Permissions

## Purpose

Describe role boundaries, privileges, delegation behavior, and permission gaps.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "design/information-architecture.md": """# Information Architecture

## Purpose

Document the product's navigation model, grouping, naming, and discoverability concerns.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "design/ux-observations.md": """# UX Observations

## Purpose

Capture usability findings, friction points, and likely comprehension issues.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "design/content-and-terminology.md": """# Content And Terminology

## Purpose

Record key terms, naming consistency issues, copy requirements, and terminology conflicts.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "design/accessibility-and-inclusion.md": """# Accessibility And Inclusion

## Purpose

Capture known accessibility expectations, likely barriers, and missing accessibility guidance.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "engineering/system-behavior.md": """# System Behavior

## Purpose

Describe state transitions, background work, automation, and important business rules.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "engineering/data-and-entities.md": """# Data And Entities

## Purpose

Describe core entities, relationships, lifecycle changes, and data ambiguities.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "engineering/interfaces-and-integrations.md": """# Interfaces And Integrations

## Purpose

Document APIs, imports, exports, external services, and boundary contracts.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "engineering/analytics-and-observability.md": """# Analytics And Observability

## Purpose

Describe tracking, metrics, dashboards, alerts, logging, and missing observability needs.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "operations/release-and-support.md": """# Release And Support

## Purpose

Describe rollout, support ownership, escalation routes, and operational dependencies.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "operations/risks-and-known-gaps.md": """# Risks And Known Gaps

## Purpose

Capture the current risk register, unclear requirements, and decisions that still block confidence.

## Confirmed

- TODO

## Inferred

- TODO

## Gaps

- TODO

## Open questions

<!-- Pointer lines only. Every question must first exist as a POQ-NNN entry in
     review/product-owner-questions.md. Add one line per POQ that applies to
     this page, in the form:
     - See POQ-NNN — <short hook> (status: open)
     See references/wiki-blueprint.md for the single-funnel rule. -->

## Sources

- intake/source-manifest.md
""",
    "review/ux-improvements.md": """# UX Improvements

## Purpose

List concrete UX improvements with rationale and expected impact.

## Recommendations

- TODO: Issue
  - Impact:
  - Proposed change:
  - Rationale:
  - Dependencies:
""",
    "review/product-owner-questions.md": """# Product Owner Questions

## Purpose

List the highest-value questions that need product-owner answers.

## Statuses

- `open`
- `answered-unreviewed`
- `integrated`
- `needs-clarification`
- `conflicts-existing-docs`
- `closed`

## Questions

### POQ-001: Placeholder decision

- Status: open
- Priority: high
- Source pages: `product/overview.md`
- Trigger agents: `answer-integrator`, `wiki-index-maintainer`
- Decision needed: Replace with the concrete decision the product owner must make.
- Why this matters: Explain what implementation or UX work is blocked by the missing answer.
- Affected areas: scope, permissions

#### Product owner answer

- Decision:
- Rationale:
- Constraints:
- Examples:
- Confidence:
- Answered by:
- Answered on:

#### Integration notes

- Assessment:
- Follow-up:
- Status owner:
""",
    "review/research-backlog.md": """# Research Backlog

## Purpose

Track missing facts that require additional artifact review or web research.

## Backlog

- TODO: Research task
  - Why it matters:
  - Best source:
  - Target page:
""",
    "intake/synthesis-notes.md": """# Synthesis Notes

## Purpose

Capture early synthesis, contradictions, assumptions, and cross-artifact patterns.

## Early observations

- TODO

## Contradictions

- TODO

## Working assumptions

- TODO

## Sources

- intake/source-manifest.md
""",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scaffold a product wiki from source artifacts.")
    parser.add_argument(
        "artifacts",
        nargs="+",
        help="Source files or directories to catalog in the wiki intake manifest.",
    )
    parser.add_argument("--product-name", required=True, help="Product name for wiki headings.")
    parser.add_argument("--output-dir", required=True, help="Destination wiki directory.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow writing into an existing output directory without failing.",
    )
    return parser.parse_args()


def collect_artifact_paths(inputs: Iterable[str]) -> List[Path]:
    results: List[Path] = []
    for raw in inputs:
        path = Path(raw).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(f"Source path does not exist: {raw}")
        if path.is_dir():
            for nested in sorted(path.rglob("*")):
                if nested.is_file() and nested.suffix.lower() in TEXT_EXTENSIONS:
                    results.append(nested)
        elif path.suffix.lower() in TEXT_EXTENSIONS:
            results.append(path)
        else:
            results.append(path)
    unique: List[Path] = []
    seen = set()
    for path in results:
        if path not in seen:
            unique.append(path)
            seen.add(path)
    return unique


def safe_read_text(path: Path) -> str:
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return "[binary or unsupported text format]"
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def summarize_text(text: str) -> str:
    stripped = re.sub(r"\s+", " ", text).strip()
    if not stripped:
        return "No readable text detected."
    return stripped[:220] + ("..." if len(stripped) > 220 else "")


def first_heading(text: str) -> str | None:
    for line in text.splitlines():
        candidate = line.strip()
        if candidate.startswith("#"):
            return candidate.lstrip("#").strip()
    return None


def write_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def build_source_manifest(wiki_root: Path, artifacts: List[Path]) -> None:
    lines = [
        "# Source Manifest",
        "",
        "## Purpose",
        "",
        "Catalog the inputs used to assemble this wiki.",
        "",
        "## Sources",
        "",
    ]
    manifest_entries = []
    for artifact in artifacts:
        text = safe_read_text(artifact)
        heading = first_heading(text)
        summary = summarize_text(text)
        relative_hint = artifact.as_posix()
        lines.append(f"### {artifact.name}")
        lines.append("")
        lines.append(f"- Path: `{relative_hint}`")
        lines.append(f"- Type: `{artifact.suffix or 'no-extension'}`")
        lines.append(f"- Heading: {heading or 'None detected'}")
        lines.append(f"- Summary: {summary}")
        lines.append("")
        manifest_entries.append(
            {
                "path": relative_hint,
                "type": artifact.suffix or "",
                "heading": heading,
                "summary": summary,
            }
        )

    write_file(wiki_root / "intake" / "source-manifest.md", "\n".join(lines).rstrip() + "\n")
    write_file(
        wiki_root / "intake" / "source-manifest.json",
        json.dumps({"sources": manifest_entries}, indent=2) + "\n",
    )


def create_wiki(output_dir: Path, product_name: str, artifacts: List[Path], force: bool) -> None:
    if output_dir.exists() and any(output_dir.iterdir()) and not force:
        raise FileExistsError(
            f"Output directory already exists and is not empty: {output_dir}. Use --force to continue."
        )
    output_dir.mkdir(parents=True, exist_ok=True)

    for relative_path, template in WIKI_FILES.items():
        write_file(output_dir / relative_path, template.format(product_name=product_name))

    build_source_manifest(output_dir, artifacts)


def main() -> int:
    args = parse_args()
    artifacts = collect_artifact_paths(args.artifacts)
    output_dir = Path(args.output_dir).expanduser().resolve()
    create_wiki(output_dir, args.product_name, artifacts, args.force)
    print(f"Created wiki scaffold at {output_dir}")
    print(f"Cataloged {len(artifacts)} artifact(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
