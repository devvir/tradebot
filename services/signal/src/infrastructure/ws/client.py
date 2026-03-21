import asyncio
import json
import logging
from collections import defaultdict, deque
from collections.abc import Callable, Awaitable
from typing import Any

import websockets
import websockets.exceptions

from .types import WsDelta, STREAM_CHANNELS, STREAM_MAXLEN

logger = logging.getLogger(__name__)

_BACKOFF_START = 1.0
_BACKOFF_MAX   = 30.0

OnDelta      = Callable[[WsDelta], Awaitable[None]]
OnReconnect  = Callable[[], Awaitable[None]]


class WsClient:
    """
    Connects to BitMEX WebSocket, subscribes to all Signal channels at startup,
    maintains stream buffers and delta-accumulated order book snapshots,
    and calls on_delta for every incoming message.

    Reconnects with exponential backoff. Calls on_reconnect after each
    successful reconnection so the registry can re-initialise ingredient buffers.
    """

    def __init__(
        self,
        url:          str,
        on_delta:     OnDelta,
        on_reconnect: OnReconnect,
    ) -> None:
        self._url          = url
        self._on_delta     = on_delta
        self._on_reconnect = on_reconnect

        # Stream buffers: channel → symbol → deque (or None for order book)
        self._buffers: dict[str, dict[str, deque[dict[str, Any]]]] = defaultdict(
            lambda: defaultdict(lambda: deque(maxlen=100))
        )

        # Order book snapshots: symbol → {"bids": {id: level}, "asks": {id: level}}
        self._order_books: dict[str, dict[str, dict]] = {}

        self._connected = False

    # ── Public API ────────────────────────────────────────────────────────────

    def get_stream_buffer(self, channel: str, symbol: str) -> list[dict[str, Any]]:
        """Return a snapshot of the current stream buffer for (channel, symbol)."""
        return list(self._buffers[channel][symbol])

    def get_order_book(self, symbol: str) -> dict[str, list[list]]:
        """Return {bids: [[price, size], ...], asks: [[price, size], ...]} sorted."""
        book = self._order_books.get(symbol, {})
        bids = sorted(book.get("bids", {}).values(), key=lambda x: -x[0])
        asks = sorted(book.get("asks", {}).values(), key=lambda x:  x[0])
        return {"bids": bids, "asks": asks}

    @property
    def connected(self) -> bool:
        return self._connected

    async def run(self) -> None:
        """Main loop — connects, subscribes, runs until process exit."""
        delay = _BACKOFF_START
        first = True

        while True:
            try:
                await self._connect_and_run()
                delay = _BACKOFF_START  # reset on clean disconnect
            except Exception as exc:
                self._connected = False
                logger.warning(f"WS disconnected: {exc} — reconnecting in {delay:.0f}s")
                await asyncio.sleep(delay)
                delay = min(delay * 2, _BACKOFF_MAX)

            if not first:
                logger.info("WS reconnected — notifying registry")
                try:
                    await self._on_reconnect()
                except Exception as exc:
                    logger.error(f"on_reconnect handler raised: {exc}")

            first = False

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _connect_and_run(self) -> None:
        async with websockets.connect(self._url) as ws:
            # Subscribe to all channels
            await ws.send(json.dumps({
                "op":   "subscribe",
                "args": STREAM_CHANNELS,
            }))

            self._connected = True
            logger.info(f"WS connected, subscribed to {len(STREAM_CHANNELS)} channels")

            async for raw in ws:
                msg = json.loads(raw)

                if "table" not in msg or "action" not in msg:
                    continue

                delta = WsDelta(
                    table=msg["table"],
                    action=msg["action"],
                    data=msg.get("data", []),
                )

                self._apply_to_stream_buffer(delta)
                await self._on_delta(delta)

    def _apply_to_stream_buffer(self, delta: WsDelta) -> None:
        table = delta.table

        if table == "orderBookL2_25":
            self._apply_order_book(delta)
            return

        maxlen = STREAM_MAXLEN.get(table)

        if maxlen is None:
            return

        for row in delta.data:
            symbol = row.get("symbol")

            if not symbol:
                continue

            buf = self._buffers[table][symbol]

            if buf.maxlen != maxlen:
                self._buffers[table][symbol] = deque(buf, maxlen=maxlen)
                buf = self._buffers[table][symbol]

            if delta.action in ("partial", "insert"):
                buf.append(row)

    def _apply_order_book(self, delta: WsDelta) -> None:
        for row in delta.data:
            symbol = row.get("symbol")

            if not symbol:
                continue

            if symbol not in self._order_books:
                self._order_books[symbol] = {"bids": {}, "asks": {}}

            book  = self._order_books[symbol]
            side  = "bids" if row.get("side") == "Buy" else "asks"
            oid   = row["id"]

            if delta.action in ("partial", "insert"):
                book[side][oid] = [row.get("price", 0), row.get("size", 0)]
            elif delta.action == "update":
                if oid in book[side]:
                    book[side][oid][1] = row.get("size", 0)
            elif delta.action == "delete":
                book[side].pop(oid, None)
