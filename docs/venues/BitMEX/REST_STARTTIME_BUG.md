# BitMEX Bug Report: `/instrument/compositeIndex` — `startTime` silently returns empty for sparse index symbols

**Endpoint:** `GET /api/v1/instrument/compositeIndex`

## Summary

When querying with a `startTime` set to a date *before* a symbol's first available record, the API returns an empty array rather than returning the first available record on or after that date. The same symbol queried without `startTime` correctly returns its earliest data.

This causes data pipeline clients to incorrectly conclude a symbol has no data, when in fact it does.

---

## Examples

### `.BXBT`

Query with `startTime` (returns empty — unexpected):
```
GET /api/v1/instrument/compositeIndex?symbol=.BXBT&startTime=2017-01-01T00:00:00.000Z&count=1&reverse=false
→ []
```
Query without `startTime` (proves data exists from 2017-03-14):
```
GET /api/v1/instrument/compositeIndex?symbol=.BXBT&count=1&reverse=false
→ [ { "timestamp": "2017-03-14T13:48:05.000Z", ... } ]
```

### `.XBTJPY`

```
GET /api/v1/instrument/compositeIndex?symbol=.XBTJPY&startTime=2017-03-01T00:00:00.000Z&count=1&reverse=false
→ []

GET /api/v1/instrument/compositeIndex?symbol=.XBTJPY&count=1&reverse=false
→ [ { "timestamp": "2017-05-09T07:40:05.000Z", ... } ]
```

### `.ETHBON`

```
GET /api/v1/instrument/compositeIndex?symbol=.ETHBON&startTime=2017-05-01T00:00:00.000Z&count=1&reverse=false
→ []

GET /api/v1/instrument/compositeIndex?symbol=.ETHBON&count=1&reverse=false
→ [ { "timestamp": "2017-07-25T02:36:00.000Z", ... } ]
```

### `.USDBON`

```
GET /api/v1/instrument/compositeIndex?symbol=.USDBON&startTime=2017-02-01T00:00:00.000Z&count=1&reverse=false
→ []

GET /api/v1/instrument/compositeIndex?symbol=.USDBON&count=1&reverse=false
→ [ { "timestamp": "2017-04-21T07:39:00.000Z", ... } ]
```

### `.XBTBON`

```
GET /api/v1/instrument/compositeIndex?symbol=.XBTBON&startTime=2017-02-01T00:00:00.000Z&count=1&reverse=false
→ []

GET /api/v1/instrument/compositeIndex?symbol=.XBTBON&count=1&reverse=false
→ [ { "timestamp": "2017-04-21T07:39:00.000Z", ... } ]
```

---

## Pattern

In each case, the `startTime` value is *before* the symbol's first record, but within a reasonable historical query range. The expected behaviour is to return the first available record on or after `startTime`. The actual behaviour is an empty response, indistinguishable from a symbol with no data at all.

Our hypothesis is that `startTime` is resolved to an internal row-ID threshold rather than compared against the `timestamp` column. Sparse symbols whose rows were inserted much later carry row-IDs beyond that threshold, causing the filter to exclude all of their data.

All examples above are reproducible via the public API.
