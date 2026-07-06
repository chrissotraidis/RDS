# 1. Overview

> A command-line utility that converts between CSV, JSON, and YAML formats
> on the local filesystem. Single-binary, no network, no persistent storage.

## Commands

- `convert --from FORMAT --to FORMAT INPUT [OUTPUT]` — read INPUT, write OUTPUT
  (or stdout if omitted) in the target format. Formats: csv, json, yaml.
- `validate INPUT` — parse INPUT and exit 0 on success, nonzero with a
  human-readable error on parse failure.
- `--help` and `--version` behave per GNU conventions.

## Behavior

- Reads from a path or `-` (stdin). Writes to a path or stdout.
- UTF-8 throughout. Non-UTF8 input emits a clear error and exits 1.
- Rounds JSON numbers to preserve precision; does not coerce types.
- Exit codes: 0 success, 1 validation error, 2 I/O error, 3 unknown format.

## Verification

- `convert --from csv --to json fixtures/people.csv` emits valid JSON.
- `validate fixtures/broken.yaml` exits 1 with a line/column in the error.
- `--help` lists all subcommands and their flags.
