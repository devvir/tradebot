# Tradebot — Project Overview

This document is written for AI agents. Read it at the start of any conversation to avoid needing a verbal briefing.

---

## Purpose

The end goal is to train and run trading strategies against real BitMEX market data, replayed at maximum speed. Most of the existing work is about collecting that data and shaping it into a form the replay engine can consume.

---

## Pre-train Data Pipeline (3 stages)

### Stage 1 — Collect

Raw data is collected from BitMEX via two paths:

- **Historic**: S3 archives and REST API snapshots
- **Realtime**: WebSocket streams

Modules: **depot** (`scribe`, `courier`) and **journal** (`broadcast`, `journalist`)

### Stage 2 — Extract

Collected data is extracted into MongoDB in a near-final shape that mirrors BitMEX's tables/channels. Data that appears in both REST and WS is stored as individual documents (REST shape), not packed in WS messages.

Module: **customs** (`clerk`, `assembler`, `registrar`)

### Stage 3 — Derive

Derived tables are generated from the extracted data:

- Quote/trade bins: 1m, 5m, 1h, 1d
- `orderBookL2_25`
- `orderBook10`

Module: **customs** (`distiller`)

---

## MongoDB

Once the pipeline has run, data lives in MongoDB at `localhost:17017` (credentials in `.env`), database `tradebot`. This is the source of truth consumed by the replay engine.

---

## Runtime Architecture

### Replay vs Live

Two modules share a common interface:

- **replay** — plays back stored data at max speed (or any configured speed)
- **live** — plays real-time BitMEX data as it arrives

Both expose identical WS and REST services. Bots use data-driven clocks (not machine clocks), so they are completely unaware of whether they are talking to `replay` or `live`.

### Bots

Bot modules sit on the consumer side of the WS/REST boundary. They are built as agnostic consumers: they interact with WS and REST the same way regardless of what feeds them.

- In **live** mode: commands are relayed to BitMEX for real effects.
- In **replay** mode: commands are simulated locally.

---

## Supporting Services

`db`, `db-feed`, `cache`, `queue`, `queue-rt`, `vault`, `registry`, `bouncer`, and others — infrastructure wiring that the pipeline and runtime modules depend on.

---

## Key Architectural Concepts

- **Services** (`services/`) are atomic pipeline stages: consume, transform, publish, or store. They have Dockerfiles and compose files but are not meaningful in isolation.
- **Modules** (`modules/`) are deployable pipelines: they wire services together into something that produces an observable, useful result on its own.
- When building something new, decide first: is this a pipeline stage (service) or a complete deployable pipeline (module)?
