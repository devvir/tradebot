"""Routing key parsing and timeframe resolution."""
import pytest

from src.signals.base import resolve_timeframe, parse_args, ArgSpec, _REQUIRED


class TestResolveTimeframe:
    def test_native_1m(self):
        assert resolve_timeframe("1m") == ("1m", 1)

    def test_native_1h(self):
        assert resolve_timeframe("1h") == ("1h", 1)

    def test_native_1d(self):
        assert resolve_timeframe("1d") == ("1d", 1)

    def test_native_1M(self):
        assert resolve_timeframe("1M") == ("1M", 1)

    def test_constructed_5m_from_1m(self):
        assert resolve_timeframe("5m") == ("1m", 5)

    def test_constructed_15m_from_1m(self):
        assert resolve_timeframe("15m") == ("1m", 15)

    def test_constructed_30m_from_1m(self):
        assert resolve_timeframe("30m") == ("1m", 30)

    def test_constructed_4h_from_1h(self):
        assert resolve_timeframe("4h") == ("1h", 4)

    def test_constructed_12h_from_1h(self):
        assert resolve_timeframe("12h") == ("1h", 12)

    def test_constructed_1w_from_1d(self):
        assert resolve_timeframe("1w") == ("1d", 7)

    def test_constructed_3d_from_1d(self):
        assert resolve_timeframe("3d") == ("1d", 3)

    def test_zero_duration_returns_string(self):
        result = resolve_timeframe("0m")

        assert isinstance(result, str)

    def test_unknown_unit_returns_string(self):
        result = resolve_timeframe("1x")

        assert isinstance(result, str)


class TestParseArgs:
    _SPECS = [
        ArgSpec("timeframe", str, _REQUIRED),
        ArgSpec("window",    int, _REQUIRED),
        ArgSpec("extra",     float, 1.5),
    ]

    def test_all_required_provided(self):
        result = parse_args(self._SPECS, ["1h", "20"])

        assert result == {"timeframe": "1h", "window": 20, "extra": 1.5}

    def test_optional_overridden(self):
        result = parse_args(self._SPECS, ["1h", "20", "2.5"])

        assert result["extra"] == 2.5

    def test_missing_required_returns_error(self):
        result = parse_args(self._SPECS, ["1h"])

        assert isinstance(result, str)
        assert "window" in result

    def test_wrong_type_returns_error(self):
        result = parse_args(self._SPECS, ["1h", "notanint"])

        assert isinstance(result, str)
        assert "window" in result
