#!/usr/bin/env bash
set -euo pipefail

test -f skills/built-in/rds-mockup-fidelity/rds-skill.yaml
bin/rds-mockup --self-test >/dev/null
echo "rds-mockup-fidelity verify ok"
