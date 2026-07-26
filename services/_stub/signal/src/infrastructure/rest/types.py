from dataclasses import dataclass
from typing import Any


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
            open=      float(d["open"]   or 0),
            high=      float(d["high"]   or 0),
            low=       float(d["low"]    or 0),
            close=     float(d["close"]  or 0),
            volume=    float(d["volume"] or 0),
            vwap=      float(d["vwap"]   or 0),
        )
