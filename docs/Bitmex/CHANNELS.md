# BitMEX WebSocket Channels: Parameters Reference

This document lists all available BitMEX WebSocket channels and details the extra parameters (beyond the channel name) required to fully identify each subscription stream.

---

## Channel Parameters

| Channel                | Parameter(s) Required to Identify | Notes |
|------------------------|------------------------------------|-------|
| orderBookL2            | symbol                             | e.g. XBTUSD |
| orderBookL2_25         | symbol                             | e.g. XBTUSD |
| orderBook10            | symbol                             | e.g. XBTUSD |
| quote                  | symbol                             | e.g. XBTUSD |
| quoteBin1m             | symbol                             | e.g. XBTUSD |
| quoteBin5m             | symbol                             | e.g. XBTUSD |
| quoteBin1h             | symbol                             | e.g. XBTUSD |
| quoteBin1d             | symbol                             | e.g. XBTUSD |
| trade                  | symbol                             | e.g. XBTUSD |
| tradeBin1m             | symbol                             | e.g. XBTUSD |
| tradeBin5m             | symbol                             | e.g. XBTUSD |
| tradeBin1h             | symbol                             | e.g. XBTUSD |
| tradeBin1d             | symbol                             | e.g. XBTUSD |
| liquidation            | symbol                             | e.g. XBTUSD |
| instrument             | symbol OR special keyword          | symbol (e.g. XBTUSD) or CONTRACTS, INDICES, DERIVATIVES, SPOT |
| funding                | symbol                             | e.g. XBTUSD |
| settlement             | symbol                             | e.g. XBTUSD |
| insurance              | None                               | Global channel |
| announcement           | None                               | Global channel |
| chat                   | None                               | Global channel |
| publicNotifications    | None                               | Global channel |
| connected              | None                               | Global channel |

---

## Notes
- All channels require the channel name for identification.
- For most market data, the symbol (e.g., XBTUSD) is required.
- The `instrument` channel can be filtered by symbol or by special keywords (CONTRACTS, INDICES, DERIVATIVES, SPOT).
- Channels like `insurance`, `announcement`, `chat`, `publicNotifications`, and `connected` are global and do not require extra parameters.
- This list covers all public channels. Private/account channels (e.g., order, position) are not included here.
