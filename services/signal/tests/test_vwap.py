"""VWAP correctness tests."""
import pytest
from collections import deque

from src.market import SymbolState, BinRecord, TradeBin
from src.signals.vwap import VWAP


def _make_state_vwap(bars: list[tuple[float, float]]) -> SymbolState:
    """Build state with (vwap, volume) pairs."""
    state = SymbolState(symbol="XBTUSD")
    buf   = deque()

    for vwap, volume in bars:
        b = TradeBin("XBTUSD", "T", vwap, vwap, vwap, vwap, volume, vwap)
        buf.append(BinRecord(bin=b, refs=1))

    state.bins["1m"] = buf

    return state


class TestVWAP:
    def test_returns_none_with_insufficient_history(self):
        indicator = VWAP(bars=5)
        state     = _make_state_vwap([(50000.0, 100.0)] * 4)

        value, _ = indicator.compute(state)

        assert value is None

    def test_equal_volume_is_average_price(self):
        """With equal volume, VWAP = arithmetic mean of prices."""
        indicator = VWAP(bars=3)
        state     = _make_state_vwap([(10.0, 100.0), (20.0, 100.0), (30.0, 100.0)])

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(20.0)

    def test_volume_weighted_correctly(self):
        """Higher volume on lower price should pull VWAP down."""
        indicator = VWAP(bars=2)
        # Price 10 with volume 900, price 20 with volume 100 → VWAP = 11
        state     = _make_state_vwap([(10.0, 900.0), (20.0, 100.0)])

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(11.0)

    def test_volume_field_is_total(self):
        indicator = VWAP(bars=2)
        state     = _make_state_vwap([(50000.0, 300.0), (50000.0, 200.0)])

        value, _ = indicator.compute(state)

        assert value["volume"] == pytest.approx(500.0)

    def test_uses_last_n_bars_only(self):
        indicator = VWAP(bars=2)
        # First bar has absurd price — should not affect result
        state     = _make_state_vwap([(9999999.0, 1000.0), (10.0, 500.0), (20.0, 500.0)])

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(15.0)
