#!/usr/bin/env bash
#
# Counts BitMEX vault messages per (table, date) bucket.
#
# Expects files arranged as:
#   <base>/<table>/<year>/<YYYYMMDD>.csv.gz
#
# A "message" is the first row of a record — non-empty first column. Continuation
# rows have an empty first/second column and don't count. Per-file CSV headers
# (`_date_,_action_,...`) are skipped.
#
# Usage: countMessages.sh [base-dir] [output-csv]
#          base-dir    defaults to the current working directory.
#          output-csv  defaults to ./docs/BitMEX/bucketCounts.csv
#
# Resume behaviour: if the output CSV already exists, any (table,date) rows
# already in it are skipped — only new files are counted and appended. The
# header is not duplicated. To start fresh, just delete the CSV first.
#
# Output:
#   - Terminal:  per-file progress, per-table subtotals, grand total
#                (totals include rows loaded from an existing CSV).
#   - CSV file:  `table,date,messages` header plus one row per file.

set -euo pipefail

base="${1:-.}"
out="${2:-./docs/BitMEX/bucketCounts.csv}"

if [ ! -d "$base" ]; then
  echo "Not a directory: $base" >&2
  exit 1
fi

base="$(cd "$base" && pwd)"

count_file() {
  local file="$1"
  zcat "$file" 2>/dev/null | awk -F',' '$1 != "_date_" && $1 != "" { n++ } END { print n+0 }'
}

table_from_path() {
  local rel="${1#$base/}"
  printf '%s' "${rel%%/*}"
}

date_from_filename() {
  local name
  name="$(basename "$1" .csv.gz)"
  printf '%s-%s-%s' "${name:0:4}" "${name:4:2}" "${name:6:2}"
}

# ── Main ──────────────────────────────────────────────────────────────────────

declare -A seen subtotals
grand_total=0
new_rows=0
skipped=0

# Load existing CSV (if any) into the seen set + subtotals, so we can resume
# without recounting and still report accurate totals at the end.
if [ -s "$out" ]; then
  while IFS=, read -r t d c; do
    seen["$t,$d"]=1
    subtotals[$t]=$(( ${subtotals[$t]:-0} + c ))
    grand_total=$((grand_total + c))
  done < <(tail -n +2 "$out")

  echo "Resuming: loaded ${#seen[@]} existing rows from $out"
else
  echo 'table,date,messages' > "$out"
fi

while IFS= read -r file; do
  table="$(table_from_path "$file")"
  date="$(date_from_filename "$file")"
  key="$table,$date"

  if [ -n "${seen[$key]:-}" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  count="$(count_file "$file")"

  printf '%-20s  %s  %12d\n' "$table" "$date" "$count"
  printf '%s,%s,%d\n' "$table" "$date" "$count" >> "$out"

  subtotals[$table]=$(( ${subtotals[$table]:-0} + count ))
  grand_total=$((grand_total + count))
  new_rows=$((new_rows + 1))
done < <(
  find "$base" -type f -name '*.csv.gz' \
    | grep -E '/[0-9]{8}\.csv\.gz$' \
    | sort
)

echo
echo '── Subtotals ──────────────────────────────────────────────────────────'

for table in $(printf '%s\n' "${!subtotals[@]}" | sort); do
  printf '%-20s  %12d\n' "$table" "${subtotals[$table]}"
done

echo '── Total ──────────────────────────────────────────────────────────────'
printf '%-20s  %12d\n' 'all' "$grand_total"

echo
echo "Appended $new_rows new rows ($skipped already present) — CSV at $out"

(head -1 "$out" && tail -n +2 "$out" | sort) > /tmp/_bucketCounts.csv && mv /tmp/_bucketCounts.csv "$out"
