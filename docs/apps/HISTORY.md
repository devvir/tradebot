# History App

Collects BitMEX market data, both real time an historic, and provides offline tools to transform between storage formats, including compression/decompression, merging, sanitization and gap-filling.

## What it is

The history app captures a continuous stream of BitMEX WebSocket messages and persists them for later use — primarily to feed the [exchange replay module](EXCHANGE.md). It is not an analytics pipeline; it is a raw data store with optional compression.

## Modules

Four deployable modules, each a self-contained pipeline:

| Module | Purpose | README | Technical ref |
|---|---|---|---|
| `collector` | Collect raw data from BitMEX WS → MongoDB | [README](../../modules/history/collector/README.md) | [COLLECTOR.md](../modules/COLLECTOR.md) |
| `archivist` | Collect, encoded and compress data from BitMEX WS → MongoDB | [README](../../modules/history/archivist/README.md) | [ARCHIVIST.md](../modules/ARCHIVIST.md) |
| `packer` | Encode+compress an existing raw collection → new collection | [README](../../modules/history/packer/README.md) | [PACKER.md](../modules/PACKER.md) |
| `unpacker` | Decode+decompress an existing compressed collection → new collection | [README](../../modules/history/unpacker/README.md) | [UNPACKER.md](../modules/UNPACKER.md) |

**collector vs archivist:** both capture live data; collector stores raw JSON, archivist stores encoded+Brotli-compressed documents (~70–80% smaller). Use archivist for long-running capture, collector for debugging or short captures where readability matters.

**packer/unpacker:** offline batch transforms. Run once against an existing collection, then stop. Use packer to compress a raw collection after the fact; use unpacker to restore a compressed collection to raw.

## Services used

| Service | Role | Docs |
|---|---|---|
| `broadcast` | BitMEX WS connection → `broadcast` exchange | [README](../../services/broadcast/README.md) · [BROADCAST.md](../services/BROADCAST.md) |
| `router` | Injects AMQP headers, routes between exchanges | [README](../../services/router/README.md) · [ROUTER.md](../services/ROUTER.md) |
| `codec` | Encode/decode + Brotli compress/decompress | [README](../../services/codec/README.md) · [CODEC.md](../services/CODEC.md) |
| `writer` | Consumes from `writer` exchange → MongoDB | [README](../../services/writer/README.md) · [WRITER.md](../services/WRITER.md) |
| `reader` | MongoDB → `reader` exchange (packer/unpacker only) | [README](../../services/reader/README.md) · [READER.md](../services/READER.md) |
| `pipe` | Native exchange-to-exchange binding, no transform | [README](../../services/pipe/README.md) |

## Data flow

```
LIVE (collector / archivist):
  BitMEX WS → broadcast → [broadcast exchange]
                                    │
                                 router (injects headers)
                                    │
                               [codec.in exchange]  ← archivist only
                                    │
                                  codec             ← archivist only
                                    │
                               [writer exchange]
                                    │
                                 writer → MongoDB

OFFLINE (packer / unpacker):
  MongoDB → reader → [reader exchange]
                            │
                         router (injects headers)
                            │
                       [codec.in exchange]
                            │
                          codec
                            │
                       [writer exchange]
                            │
                         writer → MongoDB (new collection)
```

## MongoDB collections

| Collection | Contents | Written by |
|---|---|---|
| `tradebot_collect` | Raw BitMEX messages | collector |
| `tradebot_archive` | Encoded + Brotli-compressed messages | archivist |
| `tradebot_packed` | Encoded + Brotli-compressed (from raw) | packer |
| `tradebot_unpacked` | Raw (decoded from compressed) | unpacker |
