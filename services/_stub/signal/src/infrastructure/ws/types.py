from dataclasses import dataclass, field
from typing import Any


@dataclass
class WsDelta:
    table:  str
    action: str          # "partial" | "insert" | "update" | "delete"
    data:   list[dict[str, Any]]


# Channels Signal subscribes to at startup (no symbol filter).
# Stream buffer maxlen per channel type — sized to cover the REST backfill
# overlap window (bins are slow, trade/quote are fast).
STREAM_CHANNELS: list[str] = [
    "tradeBin1m",
    "tradeBin1h",
    "tradeBin1d",
    "quoteBin1m",
    "trade",
    "quote",
    "instrument",
    "orderBookL2_25",
]

# Bin channels keep only a few entries (REST is fast; 3 bins = 3 minutes max wait)
STREAM_MAXLEN: dict[str, int] = {
    "tradeBin1m":    3,
    "tradeBin1h":    3,
    "tradeBin1d":    3,
    "quoteBin1m":    3,
    "trade":         1000,
    "quote":         100,
    "instrument":    10,
    "orderBookL2_25": 0,  # 0 = delta-accumulated snapshot, not a rolling window
}
