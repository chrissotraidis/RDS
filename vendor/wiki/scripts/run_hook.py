#!/usr/bin/env python3
"""Dispatch plugin-local automation hooks."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parent


def run_python(script: Path, args: list[str]) -> int:
    command = [sys.executable, str(script), *args]
    completed = subprocess.run(command, check=False)
    return completed.returncode


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a product wiki capability hook.")
    subparsers = parser.add_subparsers(dest="hook", required=True)

    bootstrap = subparsers.add_parser("bootstrap-wiki")
    bootstrap.add_argument("--product-name", required=True)
    bootstrap.add_argument("--output-dir", required=True)
    bootstrap.add_argument("--force", action="store_true")
    bootstrap.add_argument("artifacts", nargs="+")

    refresh = subparsers.add_parser("refresh-index")
    refresh.add_argument("wiki_root")

    briefs = subparsers.add_parser("generate-agent-briefs")
    briefs.add_argument("wiki_root")
    briefs.add_argument("--output-dir")

    answers = subparsers.add_parser("process-product-owner-answers")
    answers.add_argument("wiki_root")
    answers.add_argument("--output-dir")

    cycle = subparsers.add_parser("maintenance-cycle")
    cycle.add_argument("wiki_root")
    cycle.add_argument("--output-dir")

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.hook == "bootstrap-wiki":
        script = SCRIPTS_DIR / "bootstrap_wiki.py"
        forwarded = [
            "--product-name",
            args.product_name,
            "--output-dir",
            args.output_dir,
        ]
        if args.force:
            forwarded.append("--force")
        forwarded.extend(args.artifacts)
        return run_python(script, forwarded)

    if args.hook == "refresh-index":
        script = SCRIPTS_DIR / "build_wiki_index.py"
        return run_python(script, [args.wiki_root])

    if args.hook == "generate-agent-briefs":
        script = SCRIPTS_DIR / "generate_agent_briefs.py"
        forwarded = [args.wiki_root]
        if args.output_dir:
            forwarded.extend(["--output-dir", args.output_dir])
        return run_python(script, forwarded)

    if args.hook == "process-product-owner-answers":
        script = SCRIPTS_DIR / "process_product_owner_answers.py"
        forwarded = [args.wiki_root]
        if args.output_dir:
            forwarded.extend(["--output-dir", args.output_dir])
        return run_python(script, forwarded)

    if args.hook == "maintenance-cycle":
        index_script = SCRIPTS_DIR / "build_wiki_index.py"
        brief_script = SCRIPTS_DIR / "generate_agent_briefs.py"
        answer_script = SCRIPTS_DIR / "process_product_owner_answers.py"
        if run_python(index_script, [args.wiki_root]) != 0:
            return 1
        forwarded = [args.wiki_root]
        if args.output_dir:
            forwarded.extend(["--output-dir", args.output_dir])
        if run_python(brief_script, forwarded) != 0:
            return 1
        return run_python(answer_script, forwarded)

    raise ValueError(f"Unsupported hook: {args.hook}")


if __name__ == "__main__":
    raise SystemExit(main())
