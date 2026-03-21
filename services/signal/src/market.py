"""
MarketState — per-symbol live state fed from the WS stream.

Two-tier buffer architecture:

  Stream buffers  — always-on, fixed-size, live in WsClient.
                    Only the WS client writes them.

  Ingredient buffers — per (symbol, bin_size), demand-driven.
                       Managed here. Each BinRecord carries a `refs` counter
                       so multiple indicator instances share one buffer.
                       Indicators drive pruning via prune_counts returned
                       from compute().
"""
from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ── TradeBin ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TradeBin:
    symbol:    str
    timestamp: str
    open:      float
    high:      float
    low:       float
    close:     float
    volume:    float
    vwap:      float

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "TradeBin":
        return TradeBin(
            symbol=    d["symbol"],
            timestamp= d["timestamp"],
            open=      float(d.get("open")   or 0),
            high=      float(d.get("high")   or 0),
            low=       float(d.get("low")    or 0),
            close=     float(d.get("close")  or 0),
            volume=    float(d.get("volume") or 0),
            vwap=      float(d.get("vwap")   or 0),
        )


# ── BinRecord — one item in an ingredient buffer ──────────────────────────────

@dataclass
class BinRecord:
    bin:  TradeBin
    refs: int = 0    # number of active indicator instances still needing this item


# ── Open bar accumulator ──────────────────────────────────────────────────────

@dataclass
class OpenBar:
    symbol:    str
    open:      float = 0.0
    high:      float = 0.0
    low:       float = float("inf")
    close:     float = 0.0
    volume:    float = 0.0
    cum_pv:    float = 0.0          # cumulative price × volume (for vwap)
    timestamp: str   = ""

    def update(self, price: float, size: float, ts: str) -> None:
        if self.volume == 0:
            self.open      = price
            self.timestamp = ts

        self.high   = max(self.high, price)
        self.low    = min(self.low,  price)
        self.close  = price
        self.volume += size
        self.cum_pv += price * size

    def reset(self) -> None:
        self.open      = 0.0
        self.high      = 0.0
        self.low       = float("inf")
        self.close     = 0.0
        self.volume    = 0.0
        self.cum_pv    = 0.0
        self.timestamp = ""

    def as_bin(self) -> TradeBin | None:
        """Snapshot the current accumulator as a TradeBin. Returns None if empty."""
        if self.volume == 0:
            return None

        vwap = self.cum_pv / self.volume if self.volume else 0.0

        return TradeBin(
            symbol=    self.symbol,
            timestamp= self.timestamp,
            open=      self.open,
            high=      self.high,
            low=       self.low,
            close=     self.close,
            volume=    self.volume,
            vwap=      vwap,
        )


# ── Quote / instrument snapshot ───────────────────────────────────────────────

@dataclass
class QuoteSnapshot:
    bid:        float = 0.0
    ask:        float = 0.0
    last_price: float = 0.0
    timestamp:  str   = ""


@dataclass
class InstrumentSnapshot:
    mark_price:   float = 0.0
    funding_rate: float = 0.0
    next_funding: str   = ""
    tick_size:    float = 0.0
    lot_size:     float = 0.0


# ── Order book level ──────────────────────────────────────────────────────────

@dataclass
class OrderBook:
    # id → [price, size]  (kept as dict for O(1) delta updates)
    bids: dict[int, list[float]] = field(default_factory=dict)
    asks: dict[int, list[float]] = field(default_factory=dict)

    def sorted_bids(self, levels: int | None = None) -> list[list[float]]:
        result = sorted(self.bids.values(), key=lambda x: -x[0])
        return result[:levels] if levels else result

    def sorted_asks(self, levels: int | None = None) -> list[list[float]]:
        result = sorted(self.asks.values(), key=lambda x: x[0])
        return result[:levels] if levels else result


# ── SymbolState ───────────────────────────────────────────────────────────────

@dataclass
class SymbolState:
    symbol:      str
    open_bar:    OpenBar             = field(default_factory=lambda: OpenBar(""))
    quote:       QuoteSnapshot       = field(default_factory=QuoteSnapshot)
    instrument:  InstrumentSnapshot  = field(default_factory=InstrumentSnapshot)
    order_book:  OrderBook           = field(default_factory=OrderBook)

    # Ingredient buffers: bin_size → deque[BinRecord]
    bins: dict[str, deque[BinRecord]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.open_bar = OpenBar(self.symbol)


# ── MarketState ───────────────────────────────────────────────────────────────

class MarketState:
    """
    Central per-symbol state, updated by WS deltas.
    Ingredient buffers are created/managed here on behalf of the registry.
    """

    def __init__(self) -> None:
        self._symbols: dict[str, SymbolState] = {}

    def get(self, symbol: str) -> SymbolState:
        if symbol not in self._symbols:
            self._symbols[symbol] = SymbolState(symbol=symbol)

        return self._symbols[symbol]

    # ── WS delta handlers ────────────────────────────────────────────────────

    def apply_delta(self, table: str, action: str, data: list[dict[str, Any]]) -> None:
        handler = _TABLE_HANDLERS.get(table)

        if handler:
            for row in data:
                symbol = row.get("symbol")

                if not symbol:
                    continue

                state = self.get(symbol)
                handler(state, action, row)

    # ── Ingredient buffer management ─────────────────────────────────────────

    def ensure_bin_buffer(self, symbol: str, bin_size: str) -> deque[BinRecord]:
        state = self.get(symbol)

        if bin_size not in state.bins:
            state.bins[bin_size] = deque()

        return state.bins[bin_size]

    def add_bin(self, symbol: str, bin_size: str, tbin: TradeBin, active_refs: int) -> None:
        """Append a new completed bin to the ingredient buffer with given ref count."""
        buf = self.ensure_bin_buffer(symbol, bin_size)
        buf.append(BinRecord(bin=tbin, refs=active_refs))

    def register_indicator(self, symbol: str, bin_sizes: list[str]) -> None:
        """
        Called when a new indicator instance activates.
        Increments refs on all existing items in the relevant buffers.
        """
        state = self.get(symbol)

        for bin_size in bin_sizes:
            buf = state.bins.get(bin_size)

            if buf:
                for record in buf:
                    record.refs += 1

    def deregister_indicator(
        self,
        symbol:        str,
        bin_sizes:     list[str],
        pruned_so_far: dict[str, int],
    ) -> None:
        """
        Called when an indicator instance deactivates.
        Decrements refs on items not yet pruned by this instance.
        """
        state = self.get(symbol)

        for bin_size in bin_sizes:
            buf = state.bins.get(bin_size)

            if not buf:
                continue

            already_pruned = pruned_so_far.get(bin_size, 0)

            for i, record in enumerate(buf):
                if i >= already_pruned:
                    record.refs -= 1

        self._sweep(symbol)

    def apply_prune(
        self,
        symbol:        str,
        prune_counts:  dict[str, int],
        pruned_so_far: dict[str, int],
    ) -> None:
        """
        Apply prune feedback from a compute() call.
        Decrements refs on the newly-done items and sweeps from the front.
        """
        state = self.get(symbol)

        for bin_size, n in prune_counts.items():
            if n <= 0:
                continue

            buf           = state.bins.get(bin_size)
            already       = pruned_so_far.get(bin_size, 0)

            if not buf:
                pruned_so_far[bin_size] = already + n
                continue

            buf_list = list(buf)

            for i in range(already, min(already + n, len(buf_list))):
                buf_list[i].refs -= 1

            pruned_so_far[bin_size] = already + n

        self._sweep(symbol)

    def _sweep(self, symbol: str) -> None:
        """Remove zero-ref items from the front of every ingredient buffer."""
        state = self._symbols.get(symbol)

        if not state:
            return

        for buf in state.bins.values():
            while buf and buf[0].refs <= 0:
                buf.popleft()

    def seed_bins(
        self,
        symbol:      str,
        bin_size:    str,
        bins:        list[TradeBin],
        active_refs: int,
    ) -> None:
        """
        Bulk-load bins (from REST backfill + WS merge) into the ingredient buffer.
        Called during initialisation.
        """
        buf = self.ensure_bin_buffer(symbol, bin_size)
        buf.clear()

        for tbin in bins:
            buf.append(BinRecord(bin=tbin, refs=active_refs))

    def get_bins(self, symbol: str, bin_size: str) -> list[TradeBin]:
        """Return all bins in the ingredient buffer, oldest first."""
        state = self._symbols.get(symbol)

        if not state:
            return []

        buf = state.bins.get(bin_size)

        if not buf:
            return []

        return [r.bin for r in buf]


# ── Per-table delta handlers ──────────────────────────────────────────────────

def _handle_trade(state: SymbolState, action: str, row: dict[str, Any]) -> None:
    if action not in ("partial", "insert"):
        return

    price = float(row.get("price") or 0)
    size  = float(row.get("size")  or 0)
    ts    = row.get("timestamp", "")

    state.open_bar.update(price, size, ts)


def _handle_trade_bin(state: SymbolState, action: str, row: dict[str, Any]) -> None:
    """tradeBin* events close the current open bar. The closed bin itself
    is handled by the registry (ingredient buffer), not here."""
    if action not in ("partial", "insert"):
        return

    state.open_bar.reset()


def _handle_quote(state: SymbolState, action: str, row: dict[str, Any]) -> None:
    q = state.quote
    q.bid        = float(row.get("bidPrice") or q.bid)
    q.ask        = float(row.get("askPrice") or q.ask)
    q.last_price = float(row.get("lastPrice") or q.last_price)
    q.timestamp  = row.get("timestamp", q.timestamp)


def _handle_instrument(state: SymbolState, action: str, row: dict[str, Any]) -> None:
    ins = state.instrument
    ins.mark_price   = float(row.get("markPrice")   or ins.mark_price)
    ins.funding_rate = float(row.get("fundingRate") or ins.funding_rate)
    ins.next_funding = row.get("nextFundingTimestamp", ins.next_funding)
    ins.tick_size    = float(row.get("tickSize")    or ins.tick_size)
    ins.lot_size     = float(row.get("lotSize")     or ins.lot_size)


def _handle_order_book(state: SymbolState, action: str, row: dict[str, Any]) -> None:
    book = state.order_book
    side = book.bids if row.get("side") == "Buy" else book.asks
    oid  = row["id"]

    if action in ("partial", "insert"):
        side[oid] = [float(row.get("price") or 0), float(row.get("size") or 0)]
    elif action == "update":
        if oid in side:
            side[oid][1] = float(row.get("size") or 0)
    elif action == "delete":
        side.pop(oid, None)


_TABLE_HANDLERS: dict[str, Any] = {
    "trade":          _handle_trade,
    "tradeBin1m":     _handle_trade_bin,
    "tradeBin1h":     _handle_trade_bin,
    "tradeBin1d":     _handle_trade_bin,
    "quote":          _handle_quote,
    "instrument":     _handle_instrument,
    "orderBookL2_25": _handle_order_book,
}
