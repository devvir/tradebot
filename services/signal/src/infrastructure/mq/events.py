import logging
from collections.abc import Callable, Awaitable

import aio_pika
import aio_pika.abc

from .types import BindingEvent

logger = logging.getLogger(__name__)

_EVENT_EXCHANGE = "amq.rabbitmq.event"
_BINDING_KEYS   = ["queue.bound", "queue.unbound", "queue.deleted"]

OnBinding = Callable[[BindingEvent], Awaitable[None]]


class BindingWatcher:
    """Watches RabbitMQ queue binding events and calls the handler on each."""

    def __init__(self, url: str, on_event: OnBinding) -> None:
        self._url      = url
        self._on_event = on_event

    async def run(self) -> None:
        import asyncio
        import aio_pika

        delay = 1.0

        while True:
            try:
                await self._watch()
            except Exception as exc:
                logger.warning(f"BindingWatcher error: {exc} — reconnecting in {delay:.0f}s")
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)

    async def _watch(self) -> None:
        connection = await aio_pika.connect_robust(self._url)

        async with connection:
            channel = await connection.channel()
            queue   = await channel.declare_queue("", exclusive=True, auto_delete=True)

            for key in _BINDING_KEYS:
                await queue.bind(_EVENT_EXCHANGE, routing_key=key)

            logger.info("BindingWatcher listening for queue events")

            async with queue.iterator() as it:
                async for message in it:
                    async with message.process():
                        await self._dispatch(message)

    async def _dispatch(self, message: aio_pika.abc.AbstractIncomingMessage) -> None:
        routing_key = message.routing_key or ""

        if routing_key == "queue.bound":
            action = "bound"
        elif routing_key in ("queue.unbound", "queue.deleted"):
            action = "unbound"
        else:
            return

        headers     = message.headers or {}
        binding_key = headers.get("routing_key", "")
        queue_name  = headers.get("name", "")

        if not binding_key or not queue_name:
            return

        event = BindingEvent(action=action, routing_key=binding_key, queue=queue_name)

        try:
            await self._on_event(event)
        except Exception as exc:
            logger.error(f"on_event handler raised: {exc}")
