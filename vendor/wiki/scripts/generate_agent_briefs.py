#!/usr/bin/env python3
"""Generate specialist maintenance briefs from a product wiki."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from pathlib import Path


EXPECTED_SECTIONS = {"Purpose", "Confirmed", "Inferred", "Gaps", "Open questions", "Sources"}


@dataclass
class FileAudit:
    path: Path
    todo_count: int
    headings: set[str]
    missing_sections: list[str]
    summary: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate role-specific product wiki maintenance briefs.")
    parser.add_argument("wiki_root", help="Path to the wiki root.")
    parser.add_argument(
        "--output-dir",
        help="Destination for generated brief markdown files. Defaults to <wiki_root>/review/agent-briefs.",
    )
    return parser.parse_args()


def discover_files(wiki_root: Path) -> list[Path]:
    return [
        path
        for path in sorted(wiki_root.rglob("*.md"))
        if "agent-briefs" not in path.parts and not (path.parent == wiki_root / "index")
    ]


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def extract_headings(text: str) -> set[str]:
    headings = set()
    for line in text.splitlines():
        match = re.match(r"^##\s+(.+)$", line.strip())
        if match:
            headings.add(match.group(1).strip())
    return headings


def summarize(text: str) -> str:
    for block in text.split("\n\n"):
        line = re.sub(r"\s+", " ", block).strip()
        if not line or line.startswith("#"):
            continue
        return line[:180] + ("..." if len(line) > 180 else "")
    return "No summary available."


def audit_files(wiki_root: Path) -> list[FileAudit]:
    audits = []
    for path in discover_files(wiki_root):
        relative = path.relative_to(wiki_root)
        text = read_text(path)
        headings = extract_headings(text)
        todo_count = len(re.findall(r"\bTODO\b", text))
        missing_sections: list[str] = []
        if relative.as_posix() != "index.md" and relative.parts[0] not in {"review", "index"}:
            missing_sections = sorted(EXPECTED_SECTIONS - headings)
        audits.append(
            FileAudit(
                path=relative,
                todo_count=todo_count,
                headings=headings,
                missing_sections=missing_sections,
                summary=summarize(text),
            )
        )
    return audits


def write_brief(path: Path, title: str, purpose: str, skill_name: str, items: list[FileAudit], extra: list[str]) -> None:
    lines = [
        f"# {title}",
        "",
        "## Purpose",
        "",
        purpose,
        "",
        "## Recommended skill",
        "",
        f"- `/wiki-{skill_name}`",
        "",
        "## Focus files",
        "",
    ]
    if items:
        for item in items[:8]:
            bits = [f"`{item.path.as_posix()}`"]
            if item.todo_count:
                bits.append(f"TODOs: {item.todo_count}")
            if item.missing_sections:
                bits.append("Missing sections: " + ", ".join(item.missing_sections[:4]))
            bits.append(f"Summary: {item.summary}")
            lines.append("- " + " | ".join(bits))
    else:
        lines.append("- No obvious files were flagged by the heuristic scan.")
    lines.extend(["", "## Notes", ""])
    if extra:
        lines.extend([f"- {note}" for note in extra])
    else:
        lines.append("- No additional notes.")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    wiki_root = Path(args.wiki_root).expanduser().resolve()
    output_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else wiki_root / "review" / "agent-briefs"
    )
    audits = audit_files(wiki_root)

    gap_items = [
        audit
        for audit in audits
        if audit.todo_count or audit.missing_sections or "Gaps" in audit.headings
    ]
    research_items = [
        audit
        for audit in audits
        if audit.path.parts[0] in {"engineering", "operations"}
        or "Research" in audit.path.name.title()
        or "integrations" in audit.path.as_posix()
    ]
    ux_items = [
        audit
        for audit in audits
        if audit.path.parts[0] == "design" or "journeys" in audit.path.as_posix()
    ]
    question_items = [
        audit
        for audit in audits
        if "Open questions" in audit.headings or "Gaps" in audit.headings or audit.todo_count
    ]
    answer_items = [
        audit
        for audit in audits
        if audit.path.as_posix() in {"review/product-owner-questions.md", "product/decision-log.md"}
    ]
    index_items = audits

    write_brief(
        output_dir / "product-gap-analyst.md",
        "Product Gap Analyst Brief",
        "Identify contradictions, missing decisions, undocumented edge cases, and implementation blockers.",
        "gap-analysis",
        gap_items,
        [
            "Update operations/risks-and-known-gaps.md and review/research-backlog.md.",
            "Separate confirmed gaps from inferred risks.",
        ],
    )
    write_brief(
        output_dir / "product-web-researcher.md",
        "Product Web Researcher Brief",
        "Fill wiki gaps that depend on current external facts using sourced web research.",
        "research",
        research_items,
        [
            "Prefer primary sources and add links to the affected wiki pages.",
            "Leave unresolved questions visible when sources do not fully answer them.",
        ],
    )
    write_brief(
        output_dir / "wiki-ux-reviewer.md",
        "Wiki UX Reviewer Brief",
        "Review task flows, terminology, discoverability, and accessibility risks, then propose concrete UX improvements.",
        "ux-review",
        ux_items,
        [
            "Update design/ux-observations.md and review/ux-improvements.md.",
            "Focus on actionable changes rather than broad taste-based critique.",
        ],
    )
    write_brief(
        output_dir / "product-owner-question-curator.md",
        "Product Owner Question Curator Brief",
        "Turn ambiguity into a short list of decision-ready product-owner questions.",
        "questions",
        question_items,
        [
            "Update review/product-owner-questions.md.",
            "Prioritize questions by delivery risk and answerability.",
        ],
    )
    write_brief(
        output_dir / "answer-integrator.md",
        "Answer Integrator Brief",
        "Assess newly answered product-owner questions, update affected wiki pages, and write durable decisions into the decision log.",
        "answer-integrator",
        answer_items,
        [
            "Read review/product-owner-questions.md for items in answered-unreviewed state.",
            "Update product/decision-log.md and all affected source pages before closing a question.",
        ],
    )
    write_brief(
        output_dir / "wiki-index-maintainer.md",
        "Wiki Index Maintainer Brief",
        "Improve retrieval quality, rebuild the wiki index, and make topics easier for coding agents to find.",
        "reindex",
        index_items,
        [
            "Rebuild index/wiki-index.json and index/wiki-index.md after structural edits.",
            "Improve titles, headings, and opening summaries before rerunning the indexer when discovery is weak.",
        ],
    )

    print(f"Wrote specialist briefs to {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
