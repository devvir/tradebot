"""
Registry — lifecycle manager for active indicator instances.

Pipeline:
  1. queue.bound  → parse routing key → instantiate indicator
  2. indicator.needs() → determine data requirements
  3. REST backfill + WS stream merge → seed ingredient buffer
  4. compute loop: on each WS tick, if interval elapsed → compute → publish → prune
  5. queue.unbound → decrement refcount → deactivate at zero
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from ..market import MarketState, SymbolState, TradeBin
from ..infrastructure.mq.broker import MQBroker
from ..infrastructure.mq.types import BindingEvent
from ..infrastructure.rest.client import RestClient
from ..infrastructure.ws.client import WsClient
from .base import Indicator, DataNeeds, parse_args, resolve_timeframe

logger = logging.getLogger(__name__)

# ── Indicator registry — add new indicators here ──────────────────────────────

def _load_indicators() -> dict[str, type[Indicator]]:
    from .ema        import EMA
    from .sma        import SMA
    from .bollinger  import Bollinger
    from .rsi        import RSI
    from .vwap       import VWAP
    from .obimbalance import OBImbalance
    from .market     import Market

    return {
        "ema":         EMA,
        "sma":         SMA,
        "bollinger":   Bollinger,
        "rsi":         RSI,
        "vwap":        VWAP,
        "obimbalance": OBImbalance,
        "market":      Market,
    }


# ── Active instance tracking ──────────────────────────────────────────────────

@dataclass
class ActiveInstance:
    indicator:     Indicator
    refcount:      int
    symbol:        str
    routing_key:   str                  # e.g. "XBTUSD.ema.1m.20"
    needs:         DataNeeds
    pruned_so_far: dict[str, int]       # bin_size → items pruned so far
    last_ts_ms:    float                # data-timestamp of last compute (ms)
    initialised:   bool = False


# ── Registry ──────────────────────────────────────────────────────────────────

class Registry:
    def __init__(
        self,
        market:      MarketState,
        broker:      MQBroker,
        rest:        RestClient,
        ws_client:   WsClient,
    ) -> None:
        self._market    = market
        self._broker    = broker
        self._rest      = rest
        self._ws_client = ws_client
        self._indicators: dict[str, type[Indicator]] = _load_indicators()

        # Key: "{symbol}.{name}.{args_tuple}" → ActiveInstance
        self._active: dict[str, ActiveInstance] = {}

    # ── Binding events ────────────────────────────────────────────────────────

    async def on_binding(self, event: BindingEvent) -> None:
        key = event.routing_key

        if event.action == "bound":
            await self._activate(key)
        else:
            self._deactivate(key)

    # ── WS delta feed ─────────────────────────────────────────────────────────

    async def on_delta(self, table: str, action: str, data: list[dict[str, Any]]) -> None:
        """Called for every WS delta. Routes new bins to ingredient buffers and
        triggers compute for eligible indicator instances."""
        # Feed new completed bins into ingredient buffers
        if table in ("tradeBin1m", "tradeBin1h", "tradeBin1d") and action in ("partial", "insert"):
            for row in data:
                symbol   = row.get("symbol")
                bin_size = table.replace("tradeBin", "")

                if symbol:
                    tbin = TradeBin.from_dict(row)
                    refs = self._count_refs(symbol, bin_size)
                    self._market.add_bin(symbol, bin_size, tbin, refs)

        # Compute eligible instances
        for instance in list(self._active.values()):
            if not instance.initialised:
                continue

            state   = self._market.get(instance.symbol)
            current_ts = self._extract_ts(table, data, instance.symbol)

            if current_ts is None:
                continue

            if current_ts - instance.last_ts_ms < instance.needs.interval_ms:
                continue

            await self._compute_and_publish(instance, state, current_ts)

    # ── WS reconnect ─────────────────────────────────────────────────────────

    async def on_reconnect(self) -> None:
        """Re-initialise all ingredient buffers after a WS reconnect."""
        logger.info("Reinitialising all ingredient buffers after WS reconnect")

        for instance in list(self._active.values()):
            instance.initialised = False
            asyncio.create_task(self._initialise(instance))

    # ── Activation ───────────────────────────────────────────────────────────

    async def _activate(self, routing_key: str) -> None:
        parts = routing_key.split(".")

        if len(parts) < 2:
            logger.warning(f"Ignoring malformed routing key: {routing_key}")
            return

        symbol   = parts[0]
        name     = parts[1]
        raw_args = parts[2:]

        cls = self._indicators.get(name)

        if cls is None:
            logger.debug(f"Unknown indicator '{name}' in key '{routing_key}' — ignored")
            return

        # Parse args
        parsed = parse_args(cls.ARGS, raw_args)

        if isinstance(parsed, str):
            logger.warning(f"Bad args in '{routing_key}': {parsed}")
            return

        # Stable key for deduplication
        instance_key = f"{symbol}.{name}.{tuple(sorted(parsed.items()))}"

        if instance_key in self._active:
            self._active[instance_key].refcount += 1
            logger.debug(f"Refcount++ for {routing_key} → {self._active[instance_key].refcount}")
            return

        # Instantiate
        try:
            indicator = cls(**parsed)
        except Exception as exc:
            logger.error(f"Failed to instantiate {name}({parsed}): {exc}")
            return

        data_needs = indicator.needs()

        instance = ActiveInstance(
            indicator=   indicator,
            refcount=    1,
            symbol=      symbol,
            routing_key= routing_key,
            needs=       data_needs,
            pruned_so_far= {bs: 0 for bs in data_needs.bins},
            last_ts_ms=  0.0,
        )

        self._active[instance_key] = instance

        # Register in market state (bumps refs on existing buffer items)
        self._market.register_indicator(symbol, list(data_needs.bins.keys()))

        logger.info(f"Activated: {routing_key}")

        asyncio.create_task(self._initialise(instance))

    def _deactivate(self, routing_key: str) -> None:
        parts = routing_key.split(".")

        if len(parts) < 2:
            return

        symbol   = parts[0]
        name     = parts[1]
        raw_args = parts[2:]
        cls      = self._indicators.get(name)

        if cls is None:
            return

        parsed = parse_args(cls.ARGS, raw_args)

        if isinstance(parsed, str):
            return

        instance_key = f"{symbol}.{name}.{tuple(sorted(parsed.items()))}"
        instance     = self._active.get(instance_key)

        if not instance:
            return

        instance.refcount -= 1

        if instance.refcount > 0:
            logger.debug(f"Refcount-- for {routing_key} → {instance.refcount}")
            return

        # Fully deactivate
        self._market.deregister_indicator(
            symbol,
            list(instance.needs.bins.keys()),
            instance.pruned_so_far,
        )

        del self._active[instance_key]

        logger.info(f"Deactivated: {routing_key}")

    # ── Initialisation ────────────────────────────────────────────────────────

    async def _initialise(self, instance: ActiveInstance) -> None:
        symbol     = instance.symbol
        needs      = instance.needs
        refs       = instance.refcount

        for bin_size, count in needs.bins.items():
            try:
                await self._seed_bin_buffer(symbol, bin_size, count, refs)
            except Exception as exc:
                logger.error(f"Init failed for {instance.routing_key} ({bin_size}): {exc}")
                return

        instance.initialised   = True
        instance.pruned_so_far = {bs: 0 for bs in needs.bins}
        instance.last_ts_ms    = 0.0

        logger.info(f"Initialised: {instance.routing_key}")

    async def _seed_bin_buffer(
        self,
        symbol:   str,
        bin_size: str,
        count:    int,
        refs:     int,
    ) -> None:
        """REST backfill + WS stream merge → seed ingredient buffer."""
        # Fetch from REST
        rest_bins = await self._rest.get_bins(bin_size, symbol, count)

        # Grab stream buffer items that arrived during the REST fetch
        stream = self._ws_client.get_stream_buffer(f"tradeBin{bin_size}", symbol)
        stream_bins = [TradeBin.from_dict(r) for r in stream]

        # Discard stream bins already covered by REST (timestamp overlap)
        last_rest_ts = rest_bins[-1].timestamp if rest_bins else ""
        stream_bins  = [b for b in stream_bins if b.timestamp > last_rest_ts]

        merged = rest_bins + stream_bins

        self._market.seed_bins(symbol, bin_size, merged, refs)

    # ── Compute + publish ─────────────────────────────────────────────────────

    async def _compute_and_publish(
        self,
        instance:   ActiveInstance,
        state:      SymbolState,
        current_ts: float,
    ) -> None:
        try:
            value, prune_counts = instance.indicator.compute(state)
        except Exception as exc:
            logger.error(f"compute() raised for {instance.routing_key}: {exc}")
            return

        if value is None:
            return

        await self._broker.publish(instance.routing_key, value)

        self._market.apply_prune(instance.symbol, prune_counts, instance.pruned_so_far)

        instance.last_ts_ms = current_ts

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _count_refs(self, symbol: str, bin_size: str) -> int:
        """Count active instances that need this (symbol, bin_size) buffer."""
        count = 0

        for inst in self._active.values():
            if inst.symbol == symbol and bin_size in inst.needs.bins:
                count += 1

        return count

    def _extract_ts(
        self,
        table:  str,
        data:   list[dict[str, Any]],
        symbol: str,
    ) -> float | None:
        """Extract a data-timestamp (ms) from WS delta rows for the given symbol."""
        for row in data:
            if row.get("symbol") == symbol:
                ts = row.get("timestamp") or row.get("time")

                if ts:
                    from datetime import datetime, timezone
                    try:
                        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        return dt.timestamp() * 1000
                    except ValueError:
                        pass

        return None
