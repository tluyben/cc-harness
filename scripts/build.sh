#!/usr/bin/env bash
# Find the deno binary — checks PATH first, then common install locations.
set -euo pipefail

DENO_BIN=""
if command -v deno &>/dev/null; then
  DENO_BIN="deno"
elif [ -x "$HOME/.deno/bin/deno" ]; then
  DENO_BIN="$HOME/.deno/bin/deno"
else
  echo "error: deno not found. Install it from https://deno.land/" >&2
  exit 1
fi

echo "Using deno: $($DENO_BIN --version | head -1)"
mkdir -p dist
"$DENO_BIN" compile --allow-all --output dist/cc-harnass src/server.ts
echo "Built: dist/cc-harnass"
