from typing import Any

from ..base import Indicator, ArgSpec, DataNeeds
from ...market import SymbolState


class VWAP(Indicator):
    """
    VWAP over a rolling window of completed 1m bins.
    Σ(bin.vwap × bin.volume) / Σ(bin.volume)
    """

    ARGS = [
        ArgSpec("bars", int, 60),
    ]

    def __init__(self, bars: int = 60) -> None:
        self._bars = bars

    def needs(self) -> DataNeeds:
        return DataNeeds(bins={"1m": self._bars})

    def compute(self, state: SymbolState) -> tuple[dict[str, Any], dict[str, int]]:
        raw_bins = state.bins.get("1m")

        if not raw_bins:
            return None, {}

        bins  = [r.bin for r in raw_bins]
        prune = max(0, len(bins) - self._bars)

        if len(bins) < self._bars:
            return None, {"1m": prune}

        window     = bins[-self._bars :]
        total_vol  = sum(b.volume for b in window)

        if total_vol == 0:
            return None, {"1m": prune}

        vwap   = sum(b.vwap * b.volume for b in window) / total_vol

        return {"value": vwap, "volume": total_vol}, {"1m": prune}
