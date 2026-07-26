from typing import Any

from ..base import Indicator, ArgSpec, DataNeeds
from ...market import SymbolState


class OBImbalance(Indicator):
    """
    Order book imbalance across the top N levels.
    (bid_vol − ask_vol) / (bid_vol + ask_vol) — range −1 to +1.
    """

    ARGS = [
        ArgSpec("levels", int, 10),
    ]

    def __init__(self, levels: int = 10) -> None:
        self._levels = levels

    def needs(self) -> DataNeeds:
        return DataNeeds(order_book=True, interval_ms=500)

    def compute(self, state: SymbolState) -> tuple[dict[str, Any], dict[str, int]]:
        book     = state.order_book
        bids     = book.sorted_bids(self._levels)
        asks     = book.sorted_asks(self._levels)
        bid_vol  = sum(level[1] for level in bids)
        ask_vol  = sum(level[1] for level in asks)
        total    = bid_vol + ask_vol

        if total == 0:
            return None, {}

        value = (bid_vol - ask_vol) / total

        return (
            {"value": value, "bid_volume": bid_vol, "ask_volume": ask_vol},
            {},
        )
