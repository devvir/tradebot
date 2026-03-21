import asyncio
import logging

from .config import config
from .market import MarketState
from .infrastructure.health.server import start as start_health
from .infrastructure.mq.broker import MQBroker
from .infrastructure.mq.events import BindingWatcher
from .infrastructure.ws.client import WsClient
from .infrastructure.rest.client import RestClient
from .signals.registry import Registry

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)


async def main() -> None:
    # 1. Health server
    await start_health(port=3000)

    # 2. Shared state
    market = MarketState()

    # 3. MQ broker
    broker = MQBroker(config.rabbitmq_url)
    await broker.connect()

    # 4. REST client (stateless — no persistent connection)
    rest = RestClient(config.rest_url)

    # 5. Build registry (needs broker, rest, and ws — ws wired below)
    ws_client: WsClient | None = None

    async def on_delta_wrapper(delta):  # type: ignore[no-untyped-def]
        if ws_client is None:
            return

        market.apply_delta(delta.table, delta.action, delta.data)
        await registry.on_delta(delta.table, delta.action, delta.data)

    async def on_reconnect_wrapper() -> None:
        await registry.on_reconnect()

    ws_client = WsClient(
        url=          config.ws_url,
        on_delta=     on_delta_wrapper,
        on_reconnect= on_reconnect_wrapper,
    )

    registry = Registry(
        market=    market,
        broker=    broker,
        rest=      rest,
        ws_client= ws_client,
    )

    # 6. Binding watcher
    watcher = BindingWatcher(
        url=      config.rabbitmq_url,
        on_event= registry.on_binding,
    )

    logger.info("Signal service starting")

    # 7. Run everything concurrently
    await asyncio.gather(
        ws_client.run(),
        watcher.run(),
    )


def run() -> None:
    asyncio.run(main())


if __name__ == "__main__":
    run()
