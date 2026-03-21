## Writer

- flag incoming docs with _id (they are linked to transformations, not original storage)
- for those flagged, do not try to generate a unique _id but instead drop them if their _id is already in the db

## Reader

- could be used as the single data provider for replaying; in that case, it needs more capabilities
- it should serve both ws data (tradebot_archive) and rest paginated data (tradebot_history)
- alternatively, we could have a separate service for this, but it seems redundant

## Signal

- we must be able to generate signals starting in the past (e.g. to fill a graph with EMA200, not just start from "now")

## Rest

- if we want to really mock Bitmex Rest API, we need to fix a few things:
  - insert-only tables do NOT send data in their partials
  - it needs to allow pagination (needs an intermediate server to own the tradebot_history database)
