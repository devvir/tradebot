from typing import Any

from ..base import Indicator, ArgSpec, DataNeeds, resolve_timeframe, aggregate_bins, _REQUIRED
from ...market import SymbolState


class RSI(Indicator):
    """
    Relative Strength Index using Wilder's smoothed average of gains/losses.
    History: period × 2 bars for warmup.
    """

    ARGS = [
        ArgSpec("timeframe", str, _REQUIRED),
        ArgSpec("period",    int, 14),
    ]

    def __init__(self, timeframe: str, period: int = 14) -> None:
        result = resolve_timeframe(timeframe)

        if isinstance(result, str):
            raise ValueError(result)

        self._bin_size, self._multiplier = result
        self._period = period
        self._avg_gain: float | None = None
        self._avg_loss: float | None = None

    def needs(self) -> DataNeeds:
        return DataNeeds(bins={self._bin_size: self._period * 2})

    def compute(self, state: SymbolState) -> tuple[dict[str, Any], dict[str, int]]:
        raw_bins = state.bins.get(self._bin_size)

        if not raw_bins:
            return None, {}

        bins  = aggregate_bins([r.bin for r in raw_bins], self._multiplier)
        prune = max(0, len(bins) - self._period * 2)

        if len(bins) < self._period + 1:
            return None, {self._bin_size: prune}

        closes = [b.close for b in bins]

        # Seed on first call
        if self._avg_gain is None:
            changes   = [closes[i] - closes[i - 1] for i in range(1, self._period + 1)]
            gains     = [max(c, 0) for c in changes]
            losses    = [abs(min(c, 0)) for c in changes]
            self._avg_gain = sum(gains)  / self._period
            self._avg_loss = sum(losses) / self._period

        # Wilder smoothing over the rest
        for i in range(self._period + 1, len(closes)):
            change = closes[i] - closes[i - 1]
            gain   = max(change, 0)
            loss   = abs(min(change, 0))
            self._avg_gain = (self._avg_gain * (self._period - 1) + gain)  / self._period
            self._avg_loss = (self._avg_loss * (self._period - 1) + loss) / self._period

        if self._avg_loss == 0:
            rsi = 100.0
        else:
            rs  = self._avg_gain / self._avg_loss
            rsi = 100 - (100 / (1 + rs))

        return {"value": rsi}, {self._bin_size: prune}
