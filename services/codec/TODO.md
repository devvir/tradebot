Compress messages: new package bitmex-ws-compress (or somehow shared lib)

{
  "_id": {
    "$oid": "6991c7ba345085b59c355e85"
  },
  "table": "funding",
  "action": "partial",
  "keys": [
    "timestamp",
    "symbol"
  ],
  "types": {
    "timestamp": "timestamp",
    "symbol": "symbol",
    "fundingInterval": "timespan",
    "fundingRate": "float",
    "fundingRateDaily": "float"
  },
  "filter": {
    "symbol": "SUIUSDT"
  },
  "data": [
    {
      "timestamp": "2026-02-15T12:00:00.000Z",
      "symbol": "SUIUSDT",
      "fundingInterval": "2000-01-01T08:00:00.000Z",
      "fundingRate": -0.000223,
      "fundingRateDaily": -0.000669
    }
  ],
  "_apiVersion": "2.0.0",
  "_hash": "2026-02-15T12:00:00.000Z_partial_1"
}

-> FIRST PASS

[<action>, <symbol>, <apiVersion>, [
  [<timestamp>, <fundingInterval>, <fundingRate>, <fundintRateDaily>],
  ...
]]

- Where the following are hardcoded 'enums':
  - action (predefined: partial, insert, update, delete)
- The symbol is saved as is (but ignored in the data items)
- apiVersion is stored as number: abc > a.b.c (each 0-15)
- timestamps are stored as ints (seconds * 1000 to keep ms precision)

-> SECOND PASS

42 bits: timestamp (between 2000 and 2100, ms precision)
2 bits: action
15 bits: apiVersion
5 bits: encoderVersion
----------------------------
64 bits (one 64-bit integer)

Example from above, compressed:

```json
{
  "_id": {
    "$oid": "6991c7ba345085b59c355e85"
  },
  // encodedGlobal, encodedDataItem1, encodedDataItem2, ...
  "_": [18446744073709551616, [18446744073709551616, 18446744073709551616]]
}
```

For each table, the encoding of its data items will be different, and may take 1-N 64-bit integers.
And similar encoding for common data items (e.g. orderBook data items)
