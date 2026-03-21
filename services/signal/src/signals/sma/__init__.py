from typing import Any

from ..base import Indicator, ArgSpec, DataNeeds, resolve_timeframe, aggregate_bins, _REQUIRED
from ...market import SymbolState


class SMA(Indicator):
    """Simple moving average of bar close."""

    ARGS = [
        ArgSpec("timeframe", str, _REQUIRED),
        ArgSpec("window",    int, _REQUIRED),
    ]

    def __init__(self, timeframe: str, window: int) -> None:
        result = resolve_timeframe(timeframe)

        if isinstance(result, str):
            raise ValueError(result)

        self._bin_size, self._multiplier = result
        self._window = window

    def needs(self) -> DataNeeds:
        return DataNeeds(bins={self._bin_size: self._window})

    def compute(self, state: SymbolState) -> tuple[dict[str, Any], dict[str, int]]:
        raw_bins = state.bins.get(self._bin_size)

        if not raw_bins:
            return None, {}

        bins  = aggregate_bins([r.bin for r in raw_bins], self._multiplier)
        prune = max(0, len(bins) - self._window)

        if len(bins) < self._window:
            return None, {self._bin_size: prune}

        window_bins = bins[-self._window :]
        value       = sum(b.close for b in window_bins) / self._window

        return {"value": value}, {self._bin_size: prune}
