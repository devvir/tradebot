import logging
from typing import Any

import aiohttp

from .types import TradeBin

logger = logging.getLogger(__name__)

_MAX_PER_REQUEST = 500


class RestClient:
    def __init__(self, base_url: str) -> None:
        self._base_url = base_url.rstrip("/")

    async def get_bins(self, bin_size: str, symbol: str, count: int) -> list[TradeBin]:
        """
        Fetch `count` most-recent completed bins for (bin_size, symbol),
        oldest-first. Uses reverse=true + pagination if count > 500.
        """
        collected: list[dict[str, Any]] = []
        remaining = count

        async with aiohttp.ClientSession() as session:
            while remaining > 0:
                batch = min(remaining, _MAX_PER_REQUEST)

                params: dict[str, Any] = {
                    "binSize": bin_size,
                    "symbol":  symbol,
                    "count":   batch,
                    "reverse": "true",
                }

                if collected:
                    # Page backwards from the oldest we've seen
                    params["endTime"] = collected[-1]["timestamp"]

                url = f"{self._base_url}/trade/bucketed"

                async with session.get(url, params=params) as resp:
                    resp.raise_for_status()
                    data: list[dict[str, Any]] = await resp.json()

                if not data:
                    break

                collected.extend(data)
                remaining -= len(data)

                if len(data) < batch:
                    break

        # REST returned newest-first; reverse so result is oldest-first
        collected.reverse()

        return [TradeBin.from_dict(r) for r in collected]
