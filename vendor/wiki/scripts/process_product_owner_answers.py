#!/usr/bin/env python3
"""Turn answered product-owner questions into integration and specialist briefs."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path


QUESTION_HEADER = re.compile(r"^###\s+(.+)$", re.MULTILINE)
FIELD_LINE = re.compile(r"^- ([^:]+):\s*(.*)$")

SKILL_PURPOSES = {
    "answer-integrator": "Assess answered questions, reconcile them into the wiki, update the decision log, and move question states forward.",
    "wiki-ux-reviewer": "Review whether the new answer changes flows, terminology, navigation, or accessibility expectations.",
    "product-gap-analyst": "Check for contradictions, secondary gaps, and implementation blockers created or resolved by the new answer.",
    "product-web-researcher": "Verify external facts or current market, platform, or regulatory assumptions implied by the new answer.",
    "wiki-index-maintainer": "Update titles, summaries, keywords, and the retrieval index after the answer changes page meaning.",
}


@dataclass
class Question:
    question_id: str
    title: str
    status: str
    priority: str
    source_pages: list[str]
    explicit_triggers: list[str]
    affected_areas: list[str]
    decision_needed: str
    why_it_matters: str
    decision: str
    rationale: str
    constraints: str
    examples: str
    confidence: str
    answered_by: str
    answered_on: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Process answered product-owner questions.")
    parser.add_argument("wiki_root", help="Path to the wiki root.")
    parser.add_argument(
        "--output-dir",
        help="Destination for triggered brief files. Defaults to <wiki_root>/review/agent-briefs/triggered.",
    )
    return parser.parse_args()


def normalize_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")


def split_list(value: str) -> list[str]:
    if not value:
        return []
    return [part.strip().strip("`") for part in value.split(",") if part.strip()]


def parse_questions(text: str) -> list[Question]:
    matches = list(QUESTION_HEADER.finditer(text))
    questions: list[Question] = []
    for index, match in enumerate(matches):
        heading = match.group(1).strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[start:end]
        fields: dict[str, str] = {}
        for line in body.splitlines():
            field_match = FIELD_LINE.match(line.strip())
            if not field_match:
                continue
            fields[normalize_key(field_match.group(1))] = field_match.group(2).strip()
        if ":" in heading:
            question_id, title = [part.strip() for part in heading.split(":", 1)]
        else:
            title = heading
            question_id = normalize_key(title).upper()
        questions.append(
            Question(
                question_id=question_id,
                title=title,
                status=fields.get("status", "open").lower(),
                priority=fields.get("priority", ""),
                source_pages=split_list(fields.get("source-pages", "")),
                explicit_triggers=split_list(fields.get("trigger-agents", "")),
                affected_areas=split_list(fields.get("affected-areas", "")),
                decision_needed=fields.get("decision-needed", ""),
                why_it_matters=fields.get("why-this-matters", ""),
                decision=fields.get("decision", ""),
                rationale=fields.get("rationale", ""),
                constraints=fields.get("constraints", ""),
                examples=fields.get("examples", ""),
                confidence=fields.get("confidence", ""),
                answered_by=fields.get("answered-by", ""),
                answered_on=fields.get("answered-on", ""),
            )
        )
    return questions


def infer_triggers(question: Question) -> list[str]:
    triggers = set(question.explicit_triggers)
    triggers.add("answer-integrator")
    triggers.add("wiki-index-maintainer")

    combined = " ".join(
        [
            question.title,
            question.decision_needed,
            question.why_it_matters,
            question.decision,
            question.rationale,
            question.constraints,
            " ".join(question.affected_areas),
            " ".join(question.source_pages),
        ]
    ).lower()

    ux_keywords = {"ux", "navigation", "label", "terminology", "copy", "accessibility", "flow", "journey"}
    gap_keywords = {"permission", "role", "integration", "state", "analytics", "failure", "ownership", "constraint", "scope"}
    research_keywords = {"vendor", "competitor", "regulation", "policy", "pricing", "market", "standard", "platform", "compliance", "third-party"}

    if any(keyword in combined for keyword in ux_keywords) or any(
        path.startswith("design/") or "journeys" in path for path in question.source_pages
    ):
        triggers.add("wiki-ux-reviewer")
    if any(keyword in combined for keyword in gap_keywords) or any(
        path.startswith(("engineering/", "operations/")) or "roles-and-permissions" in path
        for path in question.source_pages
    ):
        triggers.add("product-gap-analyst")
    if any(keyword in combined for keyword in research_keywords):
        triggers.add("product-web-researcher")

    return sorted(triggers)


def assessment_for(question: Question) -> str:
    answer_text = " ".join([question.decision, question.rationale, question.constraints]).strip()
    if not answer_text:
        return "Needs clarification"
    if len(question.decision.split()) < 3:
        return "Needs clarification"
    if any(token in answer_text.lower() for token in {"tbd", "not sure", "maybe", "depends"}):
        return "Needs clarification"
    return "Accepted"


def format_question(question: Question, triggers: list[str]) -> list[str]:
    lines = [
        f"### {question.question_id}: {question.title}",
        "",
        f"- Status: `{question.status}`",
        f"- Priority: `{question.priority or 'unspecified'}`",
        f"- Suggested assessment: `{assessment_for(question)}`",
        f"- Source pages: {', '.join(f'`{page}`' for page in question.source_pages) or 'None specified'}",
        f"- Affected areas: {', '.join(question.affected_areas) or 'None specified'}",
        f"- Trigger agents: {', '.join(f'`{skill}`' for skill in triggers)}",
        f"- Decision: {question.decision or 'No decision text supplied'}",
        f"- Rationale: {question.rationale or 'No rationale supplied'}",
    ]
    if question.constraints:
        lines.append(f"- Constraints: {question.constraints}")
    if question.examples:
        lines.append(f"- Examples: {question.examples}")
    if question.confidence:
        lines.append(f"- Confidence: {question.confidence}")
    if question.answered_by or question.answered_on:
        lines.append(
            f"- Answered by: {question.answered_by or 'Unknown'} on {question.answered_on or 'Unknown date'}"
        )
    lines.append("")
    return lines


def write_skill_brief(path: Path, skill_name: str, questions: list[tuple[Question, list[str]]]) -> None:
    lines = [
        f"# {skill_name.replace('-', ' ').title()} Trigger Brief",
        "",
        "## Purpose",
        "",
        SKILL_PURPOSES[skill_name],
        "",
        "## Triggered questions",
        "",
    ]
    relevant = [(question, triggers) for question, triggers in questions if skill_name in triggers]
    if relevant:
        for question, triggers in relevant:
            lines.extend(format_question(question, triggers))
    else:
        lines.append("- No `answered-unreviewed` questions currently target this skill.")
        lines.append("")

    lines.extend(["## Notes", ""])
    if skill_name == "answer-integrator":
        lines.extend(
            [
                "- Update `product/decision-log.md` for accepted decisions.",
                "- Update affected source pages before changing a question to `integrated`.",
                "- If the answer is weak or conflicting, move the question to `needs-clarification` or `conflicts-existing-docs` instead.",
            ]
        )
    elif skill_name == "wiki-index-maintainer":
        lines.extend(
            [
                "- Rebuild `index/wiki-index.json` and `index/wiki-index.md` after structural or terminology changes.",
                "- Improve titles, headings, and first paragraphs when retrieval quality is weak.",
            ]
        )
    else:
        lines.append("- Coordinate with the answer-integrator so derivative findings land after source-page updates.")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    wiki_root = Path(args.wiki_root).expanduser().resolve()
    question_file = wiki_root / "review" / "product-owner-questions.md"
    base_output_dir = wiki_root / "review" / "agent-briefs"
    triggered_output_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else base_output_dir / "triggered"
    )

    questions = parse_questions(question_file.read_text(encoding="utf-8")) if question_file.exists() else []
    pending = [(question, infer_triggers(question)) for question in questions if question.status == "answered-unreviewed"]

    manifest = {
        "questions": [
            {
                "id": question.question_id,
                "title": question.title,
                "status": question.status,
                "priority": question.priority,
                "source_pages": question.source_pages,
                "trigger_agents": triggers,
                "suggested_assessment": assessment_for(question),
            }
            for question, triggers in pending
        ]
    }

    base_output_dir.mkdir(parents=True, exist_ok=True)
    (base_output_dir / "answer-trigger-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )

    for skill_name in SKILL_PURPOSES:
        write_skill_brief(triggered_output_dir / f"{skill_name}.md", skill_name, pending)

    print(f"Processed {len(pending)} answered product-owner question(s)")
    print(f"Wrote trigger briefs to {triggered_output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
