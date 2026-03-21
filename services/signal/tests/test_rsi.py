"""RSI correctness tests."""
import pytest

from src.signals.rsi import RSI
from .helpers import make_state


class TestRSI:
    def test_returns_none_with_insufficient_history(self):
        indicator = RSI(timeframe="1m", period=14)
        state     = make_state({"1m": [100.0] * 14})  # need period + 1

        value, _ = indicator.compute(state)

        assert value is None

    def test_all_gains_returns_100(self):
        indicator = RSI(timeframe="1m", period=3)
        # Strictly increasing series → all gains, no losses → RSI = 100
        state     = make_state({"1m": [10.0, 11.0, 12.0, 13.0, 14.0, 15.0]})

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(100.0)

    def test_all_losses_returns_0(self):
        indicator = RSI(timeframe="1m", period=3)
        # Strictly decreasing → all losses → RSI = 0
        state     = make_state({"1m": [15.0, 14.0, 13.0, 12.0, 11.0, 10.0]})

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(0.0)

    def test_rsi_in_range(self):
        indicator = RSI(timeframe="1m", period=14)
        closes    = [float(i % 7) * 100 for i in range(30)]
        state     = make_state({"1m": closes})

        value, _ = indicator.compute(state)

        if value is not None:
            assert 0.0 <= value["value"] <= 100.0

    def test_output_key(self):
        indicator = RSI(timeframe="1m", period=3)
        state     = make_state({"1m": [10.0, 11.0, 12.0, 13.0, 14.0]})

        value, _ = indicator.compute(state)

        if value is not None:
            assert "value" in value
