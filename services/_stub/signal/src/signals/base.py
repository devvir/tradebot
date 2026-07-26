"""
Indicator base class and supporting types.

Every indicator module exposes a class that inherits from Indicator and:
  - declares ARGS (positional arg specs after the indicator name in the routing key)
  - implements needs()  → DataNeeds
  - implements compute() → (output_dict, prune_counts)

Adding a new indicator: create src/signals/{name}/__init__.py,
add the name to INDICATORS in registry.py. Nothing else.
"""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar

from ..market import SymbolState, TradeBin

_REQUIRED = object()  # sentinel for required args with no default


# ── Arg spec ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ArgSpec:
    name:    str
    type:    type
    default: Any = _REQUIRED  # _REQUIRED means the arg is mandatory

    @property
    def required(self) -> bool:
        return self.default is _REQUIRED


# ── DataNeeds ─────────────────────────────────────────────────────────────────

@dataclass
class DataNeeds:
    bins:        dict[str, int] = field(default_factory=dict)
    # bin_size → number of completed bars required (e.g. {"1m": 200})
    order_book:  bool           = False
    quote:       bool           = False
    instrument:  bool           = False
    open_bar:    bool           = False
    interval_ms: int            = 1000


# ── Indicator ABC ─────────────────────────────────────────────────────────────

class Indicator(ABC):
    """
    Base class for all Signal indicators.

    Subclasses are pure computation units — no I/O, no side effects.
    State (e.g. EMA carry-over) is held on the instance; the registry
    creates one instance per unique (symbol, indicator, args) combination.
    """

    ARGS: ClassVar[list[ArgSpec]] = []

    @abstractmethod
    def needs(self) -> DataNeeds:
        """Declare what data this instance requires."""
        ...

    @abstractmethod
    def compute(self, state: SymbolState) -> tuple[dict[str, Any], dict[str, int]]:
        """
        Compute the indicator value from the current SymbolState.

        Returns:
            (output_dict, prune_counts)

        prune_counts mirrors the keys in needs().bins — how many oldest items
        this instance no longer needs since the last call, per bin_size.
        e.g. ({"value": 62.3}, {"1m": 5, "1h": 0})
        """
        ...


# ── Arg parsing ───────────────────────────────────────────────────────────────

def parse_args(specs: list[ArgSpec], raw: list[str]) -> dict[str, Any] | str:
    """
    Parse raw string args against a spec list.
    Returns a dict on success, or an error string on failure.
    """
    result: dict[str, Any] = {}

    for i, spec in enumerate(specs):
        if i < len(raw):
            try:
                result[spec.name] = spec.type(raw[i])
            except (ValueError, TypeError):
                return f"arg '{spec.name}' must be {spec.type.__name__}, got '{raw[i]}'"
        elif spec.required:
            return f"arg '{spec.name}' is required"
        else:
            result[spec.name] = spec.default

    return result


# ── Timeframe helpers ─────────────────────────────────────────────────────────

# Supported buffer levels, in descending order of size.
# Each entry: (bin_size, duration_in_minutes)
_BIN_LEVELS: list[tuple[str, int]] = [
    ("1M",  43200),   # ~30 days in minutes
    ("1d",  1440),
    ("1h",  60),
    ("1m",  1),
]

_TF_RE = re.compile(r"^(\d+)(m|h|d|M|w)$")

_WEEK_IN_MINUTES = 10080


def _tf_to_minutes(tf: str) -> int | None:
    """Convert a timeframe string to minutes. Returns None if unrecognised."""
    m = _TF_RE.match(tf)

    if not m:
        return None

    n, unit = int(m.group(1)), m.group(2)
    multipliers = {"m": 1, "h": 60, "d": 1440, "w": _WEEK_IN_MINUTES, "M": 43200}

    return n * multipliers[unit]


def resolve_timeframe(tf: str) -> tuple[str, int] | str:
    """
    Resolve a timeframe string to (base_bin_size, multiplier).

    Returns a (bin_size, multiplier) tuple on success, or an error string.
    Examples:
        "1m"  → ("1m", 1)
        "4h"  → ("1h", 4)
        "30m" → ("1m", 30)
        "1w"  → ("1d", 7)
    """
    minutes = _tf_to_minutes(tf)

    if minutes is None:
        return f"unrecognised timeframe '{tf}'"

    for bin_size, bin_minutes in _BIN_LEVELS:
        if minutes >= bin_minutes and minutes % bin_minutes == 0:
            return (bin_size, minutes // bin_minutes)

    return f"timeframe '{tf}' is not a whole multiple of any supported bin level"


def aggregate_bins(bins: list[TradeBin], multiplier: int) -> list[TradeBin]:
    """
    Group `bins` (oldest-first) into constructed bars of size `multiplier`.
    Incomplete trailing groups are discarded.
    """
    if multiplier == 1:
        return bins

    result: list[TradeBin] = []

    for i in range(0, len(bins) - len(bins) % multiplier, multiplier):
        group = bins[i : i + multiplier]

        total_vol = sum(b.volume for b in group)
        vwap      = (
            sum(b.vwap * b.volume for b in group) / total_vol
            if total_vol else 0.0
        )

        result.append(TradeBin(
            symbol=    group[0].symbol,
            timestamp= group[-1].timestamp,
            open=      group[0].open,
            high=      max(b.high for b in group),
            low=       min(b.low  for b in group),
            close=     group[-1].close,
            volume=    total_vol,
            vwap=      vwap,
        ))

    return result
