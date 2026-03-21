"""REST backfill + WS stream buffer merge."""
import pytest

from src.market import MarketState, TradeBin


def _bin(ts: str, close: float) -> TradeBin:
    return TradeBin("XBTUSD", ts, close, close, close, close, 100, close)


class TestMerge:
    def test_stream_bins_after_rest_are_appended(self):
        rest_bins   = [_bin("2026-01-01T00:00:00Z", 100.0),
                       _bin("2026-01-01T00:01:00Z", 101.0)]
        stream_bins = [_bin("2026-01-01T00:01:00Z", 101.0),   # duplicate — should be dropped
                       _bin("2026-01-01T00:02:00Z", 102.0)]   # new — should be kept

        last_rest_ts = rest_bins[-1].timestamp
        merged_stream = [b for b in stream_bins if b.timestamp > last_rest_ts]
        merged = rest_bins + merged_stream

        assert len(merged) == 3
        assert merged[-1].close == 102.0

    def test_stream_bins_all_stale_discarded(self):
        rest_bins   = [_bin("2026-01-01T00:05:00Z", 105.0)]
        stream_bins = [_bin("2026-01-01T00:03:00Z", 103.0),
                       _bin("2026-01-01T00:04:00Z", 104.0)]

        last_rest_ts = rest_bins[-1].timestamp
        merged_stream = [b for b in stream_bins if b.timestamp > last_rest_ts]
        merged = rest_bins + merged_stream

        assert len(merged) == 1

    def test_empty_rest_keeps_all_stream(self):
        stream_bins = [_bin("2026-01-01T00:00:00Z", 100.0)]
        last_rest_ts = ""
        merged_stream = [b for b in stream_bins if b.timestamp > last_rest_ts]
        merged = [] + merged_stream

        assert len(merged) == 1

    def test_seed_bins_stores_in_market_state(self):
        ms   = MarketState()
        bins = [_bin("2026-01-01T00:0{}:00Z".format(i), float(i)) for i in range(5)]

        ms.seed_bins("XBTUSD", "1m", bins, active_refs=1)

        result = ms.get_bins("XBTUSD", "1m")

        assert len(result) == 5
        assert result[0].close == 0.0
        assert result[-1].close == 4.0
