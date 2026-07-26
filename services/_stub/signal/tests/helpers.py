"""Shared test helpers."""
from collections import deque

from src.market import SymbolState, BinRecord, TradeBin, OrderBook, QuoteSnapshot


def make_bin(close: float, volume: float = 1000.0, vwap: float | None = None) -> TradeBin:
    return TradeBin(
        symbol=    "XBTUSD",
        timestamp= "2026-01-01T00:00:00.000Z",
        open=      close,
        high=      close + 10,
        low=       close - 10,
        close=     close,
        volume=    volume,
        vwap=      vwap if vwap is not None else close,
    )


def make_state(bins: dict[str, list[float]], refs: int = 1) -> SymbolState:
    """Build a SymbolState with the given close prices per bin_size."""
    state = SymbolState(symbol="XBTUSD")

    for bin_size, closes in bins.items():
        buf = deque(BinRecord(bin=make_bin(c), refs=refs) for c in closes)
        state.bins[bin_size] = buf

    return state


def make_book_state(bids: list[tuple[int, float]], asks: list[tuple[int, float]]) -> SymbolState:
    """Build a SymbolState with an order book."""
    state = SymbolState(symbol="XBTUSD")
    book  = OrderBook()

    for oid, (price, size) in enumerate(bids):
        book.bids[oid] = [price, size]

    for oid, (price, size) in enumerate(asks):
        book.asks[len(bids) + oid] = [price, size]

    state.order_book = book

    return state
