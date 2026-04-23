#!/usr/bin/env python3
"""
Download Tardis BitMEX full data feed, minute by minute, day by day.

Saves raw compressed responses to:
  /data/bitmex/tardis/YYYY-MM-DD/HH:MM:SS

On restart, already-existing files are skipped.
Non-200 responses are logged to stderr and skipped (no crash).
429 responses trigger an exponential backoff before retrying.

Usage:
  python3 download-tardis.py [START_DATE] [END_DATE]

  START_DATE  YYYY-MM-DD, default: 2019-03-30 (BitMEX availableSince)
  END_DATE    YYYY-MM-DD, non-inclusive, default: today

  Optional env vars:
    TARDIS_API_KEY   Bearer token for paid access
    TARDIS_DELAY_MS  Milliseconds between requests (default: 200)
"""

import gzip
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import date, timedelta
from pathlib import Path

BASE_URL = "https://api.tardis.dev/v1/data-feeds/bitmex"
BASE_DIR = Path("/data/bitmex/tardis")
# earliest available per Tardis metadata: 2019-03-30
BITMEX_START = date(2019, 3, 30)
MINUTES_PER_DAY = 1440

API_KEY = os.environ.get("TARDIS_API_KEY")
DELAY_S = int(os.environ.get("TARDIS_DELAY_MS", "50")) / 1000


# Sentinel: caller should skip the rest of this day
class SkipDay(Exception):
    pass


def fetch(day: str, offset: int) -> bytes | None:
    url = f"{BASE_URL}?from={day}&offset={offset}"
    req = urllib.request.Request(url)
    req.add_header("Accept-Encoding", "gzip")
    if API_KEY:
        req.add_header("Authorization", f"Bearer {API_KEY}")

    rate_backoff = 5
    retry_backoff = 5
    retries = 0
    max_retries = 5
    while True:
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                # decompress if server honoured Accept-Encoding: gzip
                if resp.headers.get("Content-Encoding") == "gzip" or (raw[:2] == b"\x1f\x8b"):
                    raw = gzip.decompress(raw)
                return raw

        except urllib.error.HTTPError as e:
            if e.code == 429:
                print(
                    f"RATE_LIMITED {day} offset={offset} — sleeping {rate_backoff}s", file=sys.stderr, flush=True)
                time.sleep(rate_backoff)
                rate_backoff = min(rate_backoff * 2, 120)
                continue
            print(f"HTTP_{e.code} {day} offset={offset}: {e.reason}",
                  file=sys.stderr, flush=True)
            if e.code in (401, 403):
                raise SkipDay()
            return None

        except SkipDay:
            raise

        except urllib.error.URLError as e:
            if isinstance(e.reason, TimeoutError):
                raise

            retries += 1
            if retries > max_retries:
                print(f"NET_ERR {day} offset={offset}: {e.reason} — giving up after {max_retries} retries",
                      file=sys.stderr, flush=True)
                return None
            print(f"NET_ERR {day} offset={offset}: {e.reason} — retry {retries}/{max_retries} in {retry_backoff}s",
                  file=sys.stderr, flush=True)
            time.sleep(retry_backoff)
            retry_backoff = min(retry_backoff * 2, 120)
            continue

        except Exception as e:
            retries += 1
            if retries > max_retries:
                print(f"ERR {day} offset={offset}: {e} — giving up after {max_retries} retries",
                      file=sys.stderr, flush=True)
                return None
            print(f"ERR {day} offset={offset}: {e} — retry {retries}/{max_retries} in {retry_backoff}s",
                  file=sys.stderr, flush=True)
            time.sleep(retry_backoff)
            retry_backoff = min(retry_backoff * 2, 120)
            continue


def run(start: date, end: date) -> None:
    current = start
    while current < end:
        if current.day != 1:
            current += timedelta(days=1)
            continue

        day_str = current.isoformat()
        day_dir = BASE_DIR / day_str
        day_dir.mkdir(parents=True, exist_ok=True)

        fetched = skipped = errors = 0

        try:
            for hour in range(24):
                gz_path = day_dir / f"{hour:02d}.ndjson.gz"

                if gz_path.exists():
                    skipped += 60
                    continue

                with gzip.open(gz_path, "wb") as fh:
                    for minute in range(60):
                        offset = hour * 60 + minute
                        data = fetch(day_str, offset)
                        time.sleep(DELAY_S)
                        if data is None:
                            errors += 1
                            continue
                        fh.write(data)
                        fetched += 1

        except SkipDay:
            # clean up any partial compressed files
            for h in range(24):
                p = day_dir / f"{h:02d}.ndjson.gz"
                if p.exists():
                    p.unlink()

        if skipped == MINUTES_PER_DAY:
            pass  # fully cached day, no noise
        elif fetched == 0 and errors == 0:
            pass  # entirely locked day, already logged
        else:
            print(
                f"{day_str}  fetched={fetched}  skipped={skipped}  errors={errors}", flush=True)

        current += timedelta(days=1)


def main() -> None:
    start = date.fromisoformat(sys.argv[1]) if len(
        sys.argv) > 1 else BITMEX_START
    end = date.fromisoformat(sys.argv[2]) if len(
        sys.argv) > 2 else date.today()

    if start < BITMEX_START:
        print(
            f"WARNING: BitMEX data starts {BITMEX_START}, adjusting start", file=sys.stderr)
        start = BITMEX_START

    print(
        f"Downloading {start} → {end}  (delay={DELAY_S*1000:.0f}ms, api_key={'yes' if API_KEY else 'no'})")
    run(start, end)


if __name__ == "__main__":
    main()
