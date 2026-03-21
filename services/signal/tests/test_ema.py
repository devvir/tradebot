"""EMA correctness tests."""
import pytest

from src.signals.ema import EMA
from .helpers import make_state


class TestEMA:
    def test_returns_none_when_insufficient_history(self):
        indicator = EMA(timeframe="1m", window=5)
        state     = make_state({"1m": [100.0] * 4})  # one short

        value, _ = indicator.compute(state)

        assert value is None

    def test_returns_value_with_sufficient_history(self):
        indicator = EMA(timeframe="1m", window=5)
        state     = make_state({"1m": [100.0] * 15})

        value, _ = indicator.compute(state)

        assert value is not None
        assert isinstance(value["value"], float)

    def test_flat_series_ema_equals_price(self):
        """EMA of a constant series converges to that constant."""
        indicator = EMA(timeframe="1m", window=5)
        state     = make_state({"1m": [50000.0] * 20})

        value, _ = indicator.compute(state)

        assert abs(value["value"] - 50000.0) < 0.01

    def test_ema_lags_rising_series(self):
        """EMA should be below current price in a rising series."""
        indicator = EMA(timeframe="1m", window=10)
        closes    = list(range(1, 40))
        state     = make_state({"1m": [float(c) for c in closes]})

        value, _ = indicator.compute(state)

        assert value["value"] < closes[-1]

    def test_prune_count_returned(self):
        indicator = EMA(timeframe="1m", window=5)
        state     = make_state({"1m": [100.0] * 20})

        _, prune = indicator.compute(state)

        assert "1m" in prune
        assert prune["1m"] >= 0

    def test_constructed_4h_resolves_to_1h_bins(self):
        indicator = EMA(timeframe="4h", window=10)

        assert indicator._bin_size   == "1h"
        assert indicator._multiplier == 4

    def test_constructed_30m_resolves_to_1m_bins(self):
        indicator = EMA(timeframe="30m", window=10)

        assert indicator._bin_size   == "1m"
        assert indicator._multiplier == 30

    def test_invalid_timeframe_raises(self):
        with pytest.raises(ValueError):
            EMA(timeframe="0m", window=10)
