"""OBImbalance correctness tests."""
import pytest

from src.signals.obimbalance import OBImbalance
from .helpers import make_book_state


class TestOBImbalance:
    def test_returns_none_when_empty_book(self):
        indicator = OBImbalance()
        state     = make_book_state([], [])

        value, _ = indicator.compute(state)

        assert value is None

    def test_equal_volumes_returns_zero(self):
        indicator = OBImbalance()
        state     = make_book_state(
            bids=[(50000.0, 500.0)],
            asks=[(50010.0, 500.0)],
        )

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(0.0)

    def test_all_bids_returns_positive_one(self):
        indicator = OBImbalance()
        state     = make_book_state(
            bids=[(50000.0, 1000.0)],
            asks=[],
        )

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(1.0)

    def test_all_asks_returns_negative_one(self):
        indicator = OBImbalance()
        state     = make_book_state(
            bids=[],
            asks=[(50010.0, 1000.0)],
        )

        value, _ = indicator.compute(state)

        assert value["value"] == pytest.approx(-1.0)

    def test_levels_truncation(self):
        """With levels=2, only top 2 levels per side are used."""
        indicator = OBImbalance(levels=2)
        # 3 bid levels; only top 2 (highest prices) should count
        state = make_book_state(
            bids=[(50000.0, 100.0), (49990.0, 100.0), (49980.0, 9999.0)],
            asks=[(50010.0, 100.0), (50020.0, 100.0), (50030.0, 9999.0)],
        )

        value, _ = indicator.compute(state)

        # top 2 bid vol = 200, top 2 ask vol = 200 → imbalance = 0
        assert value["value"] == pytest.approx(0.0)

    def test_output_keys(self):
        indicator = OBImbalance()
        state     = make_book_state(
            bids=[(50000.0, 300.0)],
            asks=[(50010.0, 200.0)],
        )

        value, _ = indicator.compute(state)

        assert "value"      in value
        assert "bid_volume" in value
        assert "ask_volume" in value
        assert value["bid_volume"] == pytest.approx(300.0)
        assert value["ask_volume"] == pytest.approx(200.0)

    def test_value_in_range(self):
        indicator = OBImbalance()
        state     = make_book_state(
            bids=[(50000.0, 700.0)],
            asks=[(50010.0, 300.0)],
        )

        value, _ = indicator.compute(state)

        assert -1.0 <= value["value"] <= 1.0
