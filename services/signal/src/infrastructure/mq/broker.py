import asyncio
import json
import logging
from collections.abc import Callable, Awaitable
from typing import Any

import aio_pika
import aio_pika.abc

logger = logging.getLogger(__name__)

_BACKOFF_START  = 1.0
_BACKOFF_MAX    = 30.0
_EXCHANGE_NAME  = "signal"


class MQBroker:
    def __init__(self, url: str) -> None:
        self._url        = url
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel:    aio_pika.abc.AbstractChannel | None          = None
        self._exchange:   aio_pika.abc.AbstractExchange | None         = None

    async def connect(self) -> None:
        delay = _BACKOFF_START

        while True:
            try:
                self._connection = await aio_pika.connect_robust(self._url)
                self._channel    = await self._connection.channel()
                self._exchange   = await self._channel.declare_exchange(
                    _EXCHANGE_NAME,
                    aio_pika.ExchangeType.TOPIC,
                    durable=True,
                )

                logger.info("Connected to RabbitMQ")

                return

            except Exception as exc:
                logger.warning(f"RabbitMQ connect failed: {exc} — retrying in {delay:.0f}s")
                await asyncio.sleep(delay)
                delay = min(delay * 2, _BACKOFF_MAX)

    async def publish(self, routing_key: str, payload: dict[str, Any]) -> None:
        if self._exchange is None:
            raise RuntimeError("Not connected")

        body = json.dumps(payload).encode()

        await self._exchange.publish(
            aio_pika.Message(body, content_type="application/json"),
            routing_key=routing_key,
        )

    async def close(self) -> None:
        if self._connection:
            await self._connection.close()
