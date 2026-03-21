from typing import Any

from ..base import Indicator, ArgSpec, DataNeeds
from ...market import SymbolState


class Market(Indicator):
    """
    Current market snapshot: bid/ask, order book, instrument data.
    Published at most every 500 ms of data-time.
    No args — bind to {SYMBOL}.market.
    """

    ARGS = []

    def needs(self) -> DataNeeds:
        return DataNeeds(
            order_book=  True,
            quote=       True,
            instrument=  True,
            interval_ms= 500,
        )

    def compute(self, state: SymbolState) -> tuple[dict[str, Any], dict[str, int]]:
        q   = state.quote
        ins = state.instrument

        if not q.bid and not q.ask:
            return None, {}

        mid    = (q.bid + q.ask) / 2 if q.bid and q.ask else 0.0
        spread = q.ask - q.bid if q.bid and q.ask else 0.0

        bids = state.order_book.sorted_bids(5)
        asks = state.order_book.sorted_asks(5)

        return (
            {
                "bid":       q.bid,
                "ask":       q.ask,
                "mid":       mid,
                "spread":    spread,
                "lastPrice": q.last_price,
                "book": {
                    "bids": bids,
                    "asks": asks,
                },
                "instrument": {
                    "markPrice":   ins.mark_price,
                    "fundingRate": ins.funding_rate,
                    "nextFunding": ins.next_funding,
                    "tickSize":    ins.tick_size,
                    "lotSize":     ins.lot_size,
                },
            },
            {},
        )
