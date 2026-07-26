"""Bollinger Bands correctness tests."""
import math
import pytest

from src.signals.bollinger import Bollinger
from .helpers import make_state


class TestBollinger:
    def test_returns_none_when_insufficient_history(self):
        indicator = Bollinger(timeframe="1m", window=5)
        state     = make_state({"1m": [100.0] * 4})

        value, _ = indicator.compute(state)

        assert value is None

    def test_mid_equals_sma(self):
        indicator = Bollinger(timeframe="1m", window=3)
        state     = make_state({"1m": [10.0, 20.0, 30.0]})

        value, _ = indicator.compute(state)

        assert value["mid"] == pytest.approx(20.0)

    def test_flat_series_zero_bandwidth(self):
        indicator = Bollinger(timeframe="1m", window=5)
        state     = make_state({"1m": [50000.0] * 5})

        value, _ = indicator.compute(state)

        assert value["upper"]     == pytest.approx(50000.0)
        assert value["lower"]     == pytest.approx(50000.0)
        assert value["bandwidth"] == pytest.approx(0.0)

    def test_upper_above_mid_lower_below(self):
        indicator = Bollinger(timeframe="1m", window=5)
        state     = make_state({"1m": [10.0, 20.0, 30.0, 40.0, 50.0]})

        value, _ = indicator.compute(state)

        assert value["upper"] > value["mid"]
        assert value["lower"] < value["mid"]

    def test_multiplier_scales_bands(self):
        indicator_1x = Bollinger(timeframe="1m", window=5, multiplier=1.0)
        indicator_2x = Bollinger(timeframe="1m", window=5, multiplier=2.0)
        closes       = [10.0, 20.0, 30.0, 40.0, 50.0]
        state        = make_state({"1m": closes})

        val_1x, _ = indicator_1x.compute(state)
        val_2x, _ = indicator_2x.compute(state)

        band_1x = val_1x["upper"] - val_1x["mid"]
        band_2x = val_2x["upper"] - val_2x["mid"]

        assert band_2x == pytest.approx(band_1x * 2)

    def test_bandwidth_formula(self):
        indicator = Bollinger(timeframe="1m", window=3, multiplier=2.0)
        state     = make_state({"1m": [10.0, 20.0, 30.0]})

        value, _ = indicator.compute(state)

        expected_bandwidth = (value["upper"] - value["lower"]) / value["mid"]

        assert value["bandwidth"] == pytest.approx(expected_bandwidth)
