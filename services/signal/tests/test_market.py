"""MarketState: delta accumulation, bin buffers, open bar, refcounting."""
import pytest

from src.market import MarketState, TradeBin


class TestOpenBar:
    def test_accumulates_trade_ticks(self):
        ms    = MarketState()
        state = ms.get("XBTUSD")

        ms.apply_delta("trade", "insert", [
            {"symbol": "XBTUSD", "price": 50000, "size": 100, "timestamp": "2026-01-01T00:00:00Z"},
            {"symbol": "XBTUSD", "price": 50100, "size": 200, "timestamp": "2026-01-01T00:00:01Z"},
        ])

        bar = state.open_bar

        assert bar.open  == 50000
        assert bar.high  == 50100
        assert bar.close == 50100
        assert bar.volume == 300

    def test_reset_on_bin_close(self):
        ms = MarketState()

        ms.apply_delta("trade", "insert", [
            {"symbol": "XBTUSD", "price": 50000, "size": 100, "timestamp": "T"},
        ])
        ms.apply_delta("tradeBin1m", "insert", [
            {"symbol": "XBTUSD", "timestamp": "T", "open": 50000, "high": 50000,
             "low": 50000, "close": 50000, "volume": 100, "vwap": 50000},
        ])

        assert ms.get("XBTUSD").open_bar.volume == 0


class TestOrderBook:
    def test_partial_populates_book(self):
        ms = MarketState()

        ms.apply_delta("orderBookL2_25", "partial", [
            {"symbol": "XBTUSD", "id": 1, "side": "Buy",  "price": 50000, "size": 500},
            {"symbol": "XBTUSD", "id": 2, "side": "Sell", "price": 50010, "size": 300},
        ])

        book = ms.get("XBTUSD").order_book

        assert len(book.bids) == 1
        assert len(book.asks) == 1

    def test_update_changes_size(self):
        ms = MarketState()

        ms.apply_delta("orderBookL2_25", "partial", [
            {"symbol": "XBTUSD", "id": 1, "side": "Buy", "price": 50000, "size": 500},
        ])
        ms.apply_delta("orderBookL2_25", "update", [
            {"symbol": "XBTUSD", "id": 1, "side": "Buy", "price": 50000, "size": 800},
        ])

        assert ms.get("XBTUSD").order_book.bids[1][1] == 800

    def test_delete_removes_level(self):
        ms = MarketState()

        ms.apply_delta("orderBookL2_25", "partial", [
            {"symbol": "XBTUSD", "id": 1, "side": "Buy", "price": 50000, "size": 500},
        ])
        ms.apply_delta("orderBookL2_25", "delete", [
            {"symbol": "XBTUSD", "id": 1, "side": "Buy"},
        ])

        assert 1 not in ms.get("XBTUSD").order_book.bids


class TestIngredientBufferRefcounting:
    def _make_bin(self, close: float) -> TradeBin:
        return TradeBin("XBTUSD", "T", close, close, close, close, 100, close)

    def test_register_bumps_refs_on_existing_items(self):
        ms = MarketState()

        ms.seed_bins("XBTUSD", "1m", [self._make_bin(c) for c in range(5)], active_refs=1)
        ms.register_indicator("XBTUSD", ["1m"])

        state = ms.get("XBTUSD")

        assert all(r.refs == 2 for r in state.bins["1m"])

    def test_prune_decrements_oldest(self):
        ms = MarketState()

        ms.seed_bins("XBTUSD", "1m", [self._make_bin(c) for c in range(5)], active_refs=1)

        pruned = {"1m": 0}
        ms.apply_prune("XBTUSD", {"1m": 2}, pruned)

        state = ms.get("XBTUSD")
        refs  = [r.refs for r in state.bins["1m"]]

        # oldest 2 decremented to 0, swept away; remaining 3 untouched
        assert len(state.bins["1m"]) == 3

    def test_sweep_removes_zero_ref_from_front(self):
        ms = MarketState()

        ms.seed_bins("XBTUSD", "1m", [self._make_bin(c) for c in range(3)], active_refs=1)

        pruned = {"1m": 0}
        ms.apply_prune("XBTUSD", {"1m": 3}, pruned)

        assert len(ms.get("XBTUSD").bins["1m"]) == 0
