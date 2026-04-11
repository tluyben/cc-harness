#!/usr/bin/env bash
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

"$DENO_BIN" test --allow-all tests/
