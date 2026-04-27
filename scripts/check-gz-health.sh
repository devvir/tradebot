#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-/data/bitmex}"
CORRUPT=()
COUNT=0

echo "Scanning $BASE for .gz files..."

while IFS= read -r -d '' f; do
  COUNT=$((COUNT + 1))

  if ! gzip -t "$f" 2>/dev/null; then
    CORRUPT+=("$f")
    echo "CORRUPT: $f"
  fi

  if ((COUNT % 100 == 0)); then
    echo "  ... $COUNT files checked so far"
  fi
done < <(find "$BASE" -type f -name "*.gz" ! -name "*.gz.*" -print0 | sort -z)

echo ""
echo "Done. $COUNT files checked."

if ((${#CORRUPT[@]} == 0)); then
  echo "All files healthy."
else
  echo "${#CORRUPT[@]} corrupt file(s):"
  printf '  %s\n' "${CORRUPT[@]}"
  exit 1
fi
