#!/usr/bin/env python3
"""Build a lightweight retrieval index for a Markdown wiki."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Dict, List


STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "todo",
    "confirmed",
    "inferred",
    "gaps",
    "sources",
    "purpose",
    "questions",
    "review",
    "open",
    "known",
    "current",
    "describe",
    "document",
    "capture",
    "list",
    "with",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a retrieval index for a Markdown wiki.")
    parser.add_argument("wiki_root", help="Path to the wiki root directory.")
    return parser.parse_args()


def discover_markdown_files(wiki_root: Path) -> List[Path]:
    results = []
    for path in sorted(wiki_root.rglob("*.md")):
        if "index" in path.parts and path.parent == wiki_root / "index":
            continue
        results.append(path)
    return results


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def title_from_text(path: Path, text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return path.stem.replace("-", " ").replace("_", " ").title()


def headings_from_text(text: str) -> List[str]:
    headings = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("##"):
            headings.append(stripped.lstrip("#").strip())
    return headings[:12]


def summary_from_text(text: str) -> str:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    for paragraph in paragraphs:
        if paragraph.startswith("#"):
            continue
        clean = re.sub(r"\s+", " ", paragraph)
        return clean[:220] + ("..." if len(clean) > 220 else "")
    return ""


def keyword_candidates(path: Path, title: str, headings: List[str], text: str) -> List[str]:
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9-]{2,}", " ".join([path.as_posix(), title, *headings, text]))
    counter: Counter[str] = Counter()
    for token in tokens:
        lower = token.lower()
        if lower in STOPWORDS or lower.isdigit():
            continue
        counter[lower] += 1
    ranked = [token for token, _count in counter.most_common(12)]
    return ranked


def section_for_path(path: Path) -> str:
    if len(path.parts) > 1:
        return path.parts[0]
    return "root"


def build_entries(wiki_root: Path) -> List[Dict[str, object]]:
    entries = []
    for path in discover_markdown_files(wiki_root):
        relative = path.relative_to(wiki_root)
        text = read_text(path)
        title = title_from_text(path, text)
        headings = headings_from_text(text)
        summary = summary_from_text(text)
        keywords = keyword_candidates(relative, title, headings, text)
        entries.append(
            {
                "path": relative.as_posix(),
                "title": title,
                "section": section_for_path(relative),
                "headings": headings,
                "summary": summary,
                "keywords": keywords,
            }
        )
    return entries


def write_json_index(index_dir: Path, entries: List[Dict[str, object]]) -> None:
    payload = {"entries": entries}
    index_dir.mkdir(parents=True, exist_ok=True)
    (index_dir / "wiki-index.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def write_markdown_index(index_dir: Path, entries: List[Dict[str, object]]) -> None:
    lines = [
        "# Wiki Index",
        "",
        "## Purpose",
        "",
        "Quick lookup table for the product wiki.",
        "",
        "| Section | Title | Path | Keywords |",
        "| --- | --- | --- | --- |",
    ]
    for entry in entries:
        keywords = ", ".join(entry["keywords"][:6])
        lines.append(
            f"| {entry['section']} | {entry['title']} | `{entry['path']}` | {keywords} |"
        )
    index_dir.mkdir(parents=True, exist_ok=True)
    (index_dir / "wiki-index.md").write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    wiki_root = Path(args.wiki_root).expanduser().resolve()
    if not wiki_root.exists():
        raise FileNotFoundError(f"Wiki root does not exist: {wiki_root}")
    entries = build_entries(wiki_root)
    index_dir = wiki_root / "index"
    write_json_index(index_dir, entries)
    write_markdown_index(index_dir, entries)
    print(f"Indexed {len(entries)} markdown file(s) in {wiki_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
