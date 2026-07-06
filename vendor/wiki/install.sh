#!/usr/bin/env bash
# Install product-wiki-capability as a local plugin for Claude Code.
# Run from the repo root: ./install.sh
#
# To uninstall: ./install.sh --uninstall

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_NAME="product-wiki-capability"

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "To uninstall, remove the --plugin-dir reference from your Claude Code launch command"
  echo "or remove this repo from your marketplace sources."
  exit 0
fi

echo "product-wiki-capability plugin"
echo "=============================="
echo ""
echo "Plugin root: $REPO_DIR"
echo ""
echo "Usage options:"
echo ""
echo "  1. Local development (load directly):"
echo "     claude --plugin-dir $REPO_DIR"
echo ""
echo "  2. Test in current session:"
echo "     /plugin install --plugin-dir $REPO_DIR"
echo ""
echo "  3. Skills will be namespaced as:"
echo "     /wiki:wiki-steward"
echo "     /wiki:wiki-bootstrap"
echo "     /wiki:wiki-gap-analysis"
echo "     /wiki:wiki-research"
echo "     /wiki:wiki-ux-review"
echo "     /wiki:wiki-questions"
echo "     /wiki:wiki-reindex"
echo "     /wiki:wiki-maintenance"
echo "     /wiki:wiki-answer-integrator"
echo "     /wiki:wiki-process-answers"
echo ""
echo "  4. Scripts available at:"
echo "     $REPO_DIR/scripts/"
