# Courier Service — Technical Reference

## Overview

```
BitMEX S3  →  courier  →  vault (PUT /files/:table/:date)
```

Courier downloads BitMEX public S3 gzip dumps for the `trade` and `quote` tables
and streams the raw bytes directly to vault. No intermediate disk I/O — the S3
response body is piped straight to the vault PUT request.

## Tables

| Table | First available date |
|---|---|
| `trade` | 2014-11-22 |
| `quote` | 2014-11-22 |

## Download Flow

1. On startup, calls `GET /files/:table` on vault to discover which dates are already present.
2. Computes the full date range from `2014-11-22` up to and including yesterday UTC.
3. For each missing date, calls `fetchAndStore`:
   - Fetches `https://s3-eu-west-1.amazonaws.com/public.bitmex.com/data/<table>/<date>.csv.gz`
   - Streams the response body to `PUT /files/:table/:date` on vault
   - `404` on S3 → file does not exist yet, skip silently
   - `409` from vault → already stored (e.g. from a previous run), skip
4. Schedules a self-rescheduling timer to fire at the next UTC midnight and repeat the sync.

## Retry Behaviour

**S3 fetch failures:** Retried up to 5 times with exponential backoff starting at 1 s
(`1s → 2s → 4s → 8s → 16s`). After 5 failures the error propagates and the date is
skipped for this cycle.

**Vault unreachable:** Retried indefinitely with a fixed 5 s delay. A single warning is
logged on first failure and a single info is logged on recovery — no repeated noise.
