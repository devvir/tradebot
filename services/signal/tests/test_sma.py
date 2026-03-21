"""SMA correctness tests."""
import pytest

from src.signals.sma import SMA
from .helpers import make_state


class TestSMA:
    def test_returns_none_when_insufficient_history(self):
        indicator = SMA(timeframe="1m", window=5)
        state     = make_state({"1m": [100.0] * 4})

        value, _ = indicator.compute(state)

        assert value is None

    def test_exact_average_of_window(self):
        indicator = SMA(timeframe="1m", window=3)
        state     = make_state({"1m": [10.0, 20.0, 30.0]})

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(20.0)

    def test_uses_last_n_bars_only(self):
        indicator = SMA(timeframe="1m", window=3)
        # Last 3 are 10, 20, 30 → SMA = 20; earlier values should not affect it
        state     = make_state({"1m": [9999.0, 9999.0, 10.0, 20.0, 30.0]})

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(20.0)

    def test_flat_series(self):
        indicator = SMA(timeframe="1m", window=10)
        state     = make_state({"1m": [42.5] * 10})

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(42.5)

    def test_prune_not_greater_than_buffer(self):
        indicator = SMA(timeframe="1m", window=3)
        state     = make_state({"1m": [1.0, 2.0, 3.0, 4.0, 5.0]})

        _, prune = indicator.compute(state)

        assert prune["1m"] == 2   # 5 bars - window(3) = 2 pruneable
