#!/usr/bin/env bash
#
# Scan every *.csv.gz in a directory for non-ASCII bytes (corruption check).
# Logs per-file progress with timestamps so the run can be checked or resumed
# mentally at any point. Designed to be launched detached (nohup + disown) for
# long overnight runs.
#
# Usage: scan-nonascii.sh <dir>
#
set -u

dir="${1:?usage: scan-nonascii.sh <dir>}"
cd "$dir" || exit 1

total=$(ls -1 *.csv.gz 2>/dev/null | wc -l)
n=0
bad=0

echo "[$(date '+%F %T')] START  $dir  ($total files)"

for f in *.csv.gz; do
  n=$((n + 1))
  echo "[$(date '+%F %T')] ($n/$total) $f"

  if pigz -dc "$f" 2>/dev/null | LC_ALL=C grep -qP '[^\x09\x0a\x0d\x20-\x7e]'; then
    echo "[$(date '+%F %T')]   NON-ASCII  $f"
    bad=$((bad + 1))
  fi
done

echo "[$(date '+%F %T')] DONE  scanned $n files, $bad with non-ASCII"
