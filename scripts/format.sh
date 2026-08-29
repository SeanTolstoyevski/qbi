#!/usr/bin/env bash
# Format the Go sources with gofmt and the frontend JS/Vue sources with Prettier.
#
# Usage:
#   ./scripts/format.sh           format files in place
#   ./scripts/format.sh --check   only report files that would change
#
# Requires bash (Git Bash on Windows, or any Unix shell), Go on PATH, and the
# frontend dependencies installed (cd frontend && npm install).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-}" in
  --check|"") ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac

cd "$ROOT"

# Format with gofmt. Generated bindings under frontend/, build output and the
# go mod vendor directory are excluded (vendored packages must not be touched).
GO_FILES() {
  find "$ROOT" -name '*.go' \
    -not -path "$ROOT/frontend/*" \
    -not -path "$ROOT/build/*" \
    -not -path "$ROOT/vendor/*" "$@"
}

go_unformatted="$(GO_FILES -exec gofmt -l {} +)"
if [ -n "$go_unformatted" ]; then
  if [ "${1:-}" = "--check" ]; then
    echo "Go files need formatting:" >&2
    echo "$go_unformatted" >&2
    exit 1
  fi
  GO_FILES -exec gofmt -w {} +
fi

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
esac
