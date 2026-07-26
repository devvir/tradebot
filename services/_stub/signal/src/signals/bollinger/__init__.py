import math
from typing import Any

from ..base import Indicator, ArgSpec, DataNeeds, resolve_timeframe, aggregate_bins, _REQUIRED
from ...market import SymbolState


class Bollinger(Indicator):
    """Bollinger Bands: SMA ± multiplier × stddev of close."""

    ARGS = [
        ArgSpec("timeframe",  str,   _REQUIRED),
        ArgSpec("window",     int,   _REQUIRED),
        ArgSpec("multiplier", float, 2.0),
    ]

    def __init__(self, timeframe: str, window: int, multiplier: float = 2.0) -> None:
        result = resolve_timeframe(timeframe)

        if isinstance(result, str):
            raise ValueError(result)

        self._bin_size, self._multiplier_tf = result
        self._window     = window
        self._multiplier = multiplier

    def needs(self) -> DataNeeds:
        return DataNeeds(bins={self._bin_size: self._window})

    def compute(self, state: SymbolState) -> tuple[dict[str, Any], dict[str, int]]:
        raw_bins = state.bins.get(self._bin_size)

        if not raw_bins:
            return None, {}

        bins  = aggregate_bins([r.bin for r in raw_bins], self._multiplier_tf)
        prune = max(0, len(bins) - self._window)

        if len(bins) < self._window:
            return None, {self._bin_size: prune}

        closes = [b.close for b in bins[-self._window :]]
        mid    = sum(closes) / self._window
        var    = sum((c - mid) ** 2 for c in closes) / self._window
        std    = math.sqrt(var)
        band   = self._multiplier * std

        return (
            {
                "mid":       mid,
                "upper":     mid + band,
                "lower":     mid - band,
                "bandwidth": (2 * band) / mid if mid else 0.0,
            },
            {self._bin_size: prune},
        )
