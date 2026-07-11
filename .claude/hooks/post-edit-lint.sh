#!/usr/bin/env bash
set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Extract the file path from the tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Skip if no file path or not a TS/TSX file
if [[ -z "$FILE_PATH" ]] || [[ ! "$FILE_PATH" =~ \.(ts|tsx)$ ]]; then
  exit 0
fi

# Skip if file doesn't exist (was deleted)
if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

# Skip config files (eslint ignores them; they are not part of the typecheck graph)
case "$FILE_PATH" in
  *.config.ts | *.config.js) exit 0 ;;
esac

# Step 1: Run eslint --fix on the changed file
ESLINT_OUTPUT=$(npx eslint --fix "$FILE_PATH" 2>&1) || {
  echo "ESLint errors in $FILE_PATH:" >&2
  echo "$ESLINT_OUTPUT" >&2
  exit 2
}

# Step 2: Run tsc --noEmit using the nearest tsconfig.json (only if eslint passed)
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // empty')
TSCONFIG=""
DIR=$(dirname "$FILE_PATH")
while [[ ${#DIR} -ge ${#PROJECT_ROOT} ]]; do
  if [[ -f "$DIR/tsconfig.json" ]]; then
    TSCONFIG="$DIR/tsconfig.json"
    break
  fi
  DIR=$(dirname "$DIR")
done

if [[ -n "$TSCONFIG" ]]; then
  TSC_OUTPUT=$(npx tsc --noEmit -p "$TSCONFIG" 2>&1) || {
    echo "TypeScript errors:" >&2
    echo "$TSC_OUTPUT" >&2
    exit 2
  }
fi

exit 0
