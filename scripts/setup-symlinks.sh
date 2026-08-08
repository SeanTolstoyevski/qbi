#!/usr/bin/env bash
# setup-symlinks.sh - Create symlinks (or copies) so every LLM agent reads the
# same canonical instructions file: .agent/agent.md
#
# Run this once after cloning the repo:
#   bash setup-symlinks.sh
#
# The generated files should be listed in .gitignore so each contributor runs
# this script locally rather than committing the links.
#
# On Linux/macOS this creates real symlinks. On Windows it tries native
# symlinks first (needs Developer Mode or admin), then falls back to copies.

set -euo pipefail

SOURCE=".agent/agent.md"
TARGETS=(
  "AGENT.md"
  "GEMINI.md"
  "CLAUDE.md"
  "REASONIX.md"
  ".github/copilot-instructions.md"
)

if [ ! -f "$SOURCE" ]; then
  echo "Error: $SOURCE not found. Create it first." >&2
  exit 1
fi

create_link() {
  local src="$1"
  local dst="$2"

  rm -f "$dst"

  if MSYS=winsymlinks:nativestrict ln -s "$src" "$dst" 2>/dev/null; then
    return 0
  fi

  if command -v cmd >/dev/null 2>&1; then
    if cmd //c "mklink \"$dst\" \"$src\"" >/dev/null 2>&1; then
      return 0
    fi
  fi

  if ln -s "$src" "$dst" 2>/dev/null; then
    echo -n " (copy — admin/Developer Mode needed for true symlinks)"
    return 0
  fi

  cp "$src" "$dst"
  echo -n " (copy — symlink failed)"
}

echo "Creating links -> $SOURCE"
for target in "${TARGETS[@]}"; do
  printf "  %s" "$target"
  create_link "$SOURCE" "$target"
  echo ""
done

echo ""
echo "Done. Add these files to .gitignore if you haven't already:"
printf '  %s\n' "${TARGETS[@]}"
