#!/usr/bin/env bash
# Format the frontend JS and Vue sources with Prettier.
#
# Usage:
#   ./scripts/format.sh           format files in place
#   ./scripts/format.sh --check   only report files that would change
#
# Requires bash (Git Bash on Windows, or any Unix shell) and the frontend
# dependencies installed (cd frontend && npm install).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/frontend"

if [ ! -d node_modules ]; then
  echo "Frontend dependencies are not installed. Run: cd frontend && npm install" >&2
  exit 1
fi

case "${1:-}" in
  --check)
    npm run format:check
    ;;
  "")
    npm run format
    ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac
