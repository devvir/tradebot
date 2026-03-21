from typing import Any

from ..base import Indicator, ArgSpec, DataNeeds, resolve_timeframe, aggregate_bins, _REQUIRED
from ...market import SymbolState


class EMA(Indicator):
    """Exponential moving average of bar close (seeded with SMA)."""

    ARGS = [
        ArgSpec("timeframe", str, _REQUIRED),
        ArgSpec("window",    int, _REQUIRED),
    ]

    def __init__(self, timeframe: str, window: int) -> None:
        result = resolve_timeframe(timeframe)

        if isinstance(result, str):
            raise ValueError(result)

        self._bin_size, self._multiplier = result
        self._window   = window
        self._k        = 2 / (window + 1)
        self._ema: float | None = None

    def needs(self) -> DataNeeds:
        return DataNeeds(bins={self._bin_size: self._window * 3})

    def compute(self, state: SymbolState) -> tuple[dict[str, Any], dict[str, int]]:
        raw_bins = state.bins.get(self._bin_size)

        if not raw_bins:
            return None, {}

        bins  = aggregate_bins([r.bin for r in raw_bins], self._multiplier)
        prune = max(0, len(bins) - self._window * 3)

        if len(bins) < self._window:
            return None, {self._bin_size: prune}

        closes = [b.close for b in bins]

        if self._ema is None:
            self._ema = sum(closes[: self._window]) / self._window

        for close in closes[self._window :]:
            self._ema = close * self._k + self._ema * (1 - self._k)

        return {"value": self._ema}, {self._bin_size: prune}
