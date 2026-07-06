#!/usr/bin/env bash
set -euo pipefail

test -f skills/built-in/rds-secrets-broker/rds-skill.yaml
echo "rds-secrets-broker verify ok"
