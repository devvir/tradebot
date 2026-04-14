import crypto from 'node:crypto';
import type { MessageCheck, DiagnosticIssue, CheckContext } from './types';
import type { Message } from '../types';

/**
 * Detect duplicate messages using a minute-bucketed sliding window.
 *
 * Two messages are duplicates when their action matches and the sha256 of
 * their records (with the `_date_` field blanked) matches — same scheme as
 * `mergeTable`'s dedup key.
 *
 * The window is keyed by *canonical-field minutes*: `timestamp` when configured,
 * `_date_` otherwise. Window size is measured in distinct minute-buckets
 * (`WINDOW_MINUTES`), not elapsed wall time — so slow tables can span hours
 * and fast tables span minutes.
 *
 * Exported so the fix pipeline can size its streaming flush window to match:
 * two messages in different canonical-minute buckets cannot be duplicates,
 * so bucket boundaries are dedup-safe flush points.
 */
export const WINDOW_MINUTES = 15;

/**
 * Pre-filter for tables with a canonical exchange timestamp.
 *
 * High-frequency tables (e.g. instrument, orderBookL2) can produce rapid
 * field bounce-backs within a single exchange millisecond — e.g. the tick
 * direction cycling ZeroMinusTick → MinusTick → ZeroMinusTick in the same
 * timestamp group. The first and third messages have identical content hashes
 * but are distinct events.
 *
 * The lobby holds the hashes seen within the current exchange timestamp. A
 * hash that repeats within the same timestamp is a bounce-back and gets a
 * free pass (not flagged, not registered). When the timestamp advances the
 * lobby clears and the next group starts fresh.
 */
interface DedupLobby {
  lastTs:  string;
  entries: Map<string, string>; // hash → _date_
}

export function createDuplicateCheck(): MessageCheck {
  const seen:    Map<string, string>      = new Map(); // key → firstDate
  const buckets: Map<string, Set<string>> = new Map(); // minuteKey → keys in bucket
  const order:   string[]                 = [];         // minuteKeys in arrival order
  const lobby:   DedupLobby              = { lastTs: '', entries: new Map() };

  return {
    kind: 'message',
    name: 'duplicates',

    onMessage(msg, ctx): DiagnosticIssue[] {
      // In timeless (small) tables, partials are reconnection snapshots.
      // They'll always look identical across reconnections and flagging them
      // as duplicates adds noise without signal — skip them entirely.
      if (msg.action === 'partial' && ctx.timestampCol === null) {
        return [];
      }

      // The `connected` table reflects live connection state: the same user
      // appearing multiple times just means they disconnected and reconnected.
      // There is no meaningful notion of a duplicate here.
      if (ctx.tableName === 'connected') {
        return [];
      }

      const key       = messageKey(msg, ctx);
      const minuteKey = canonicalMinute(msg, ctx);

      // Lobby gate: only for tables with a canonical exchange timestamp.
      // Bounce-backs (same content, same exchange ms) get a free pass and are
      // never registered — only a different exchange ms can confirm a real dupe.
      if (ctx.timestampCol && msg.timestamp) {
        if (msg.timestamp !== lobby.lastTs) {
          lobby.entries.clear();
          lobby.lastTs = msg.timestamp;
        }

        if (lobby.entries.has(key)) {
          return [];
        }

        lobby.entries.set(key, msg.date);
      }

      advanceWindow(minuteKey, order, buckets, seen);

      const firstDate = seen.get(key);

      if (firstDate !== undefined) {
        return [{
          type:      'duplicate',
          message:   `duplicate of message first seen at ${firstDate}`,
          date:      msg.date,
          firstDate,
        }];
      }

      seen.set(key, msg.date);
      buckets.get(minuteKey)?.add(key);

      return [];
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Canonical minute key for a message. Uses `timestamp` when `ctx.timestampCol`
 * is set and the value is present, `_date_` otherwise.
 */
function canonicalMinute(msg: Message, ctx: CheckContext): string {
  const canonical = ctx.timestampCol && msg.timestamp ? msg.timestamp : msg.date;

  return canonical.slice(0, 16);
}

/**
 * Advance the sliding window to include `minuteKey`. Evict the oldest bucket(s)
 * when the window exceeds `WINDOW_MINUTES` distinct minute keys.
 */
function advanceWindow(
  minuteKey: string,
  order:     string[],
  buckets:   Map<string, Set<string>>,
  seen:      Map<string, string>,
): void {
  if (buckets.has(minuteKey)) {
    return;
  }

  buckets.set(minuteKey, new Set());
  order.push(minuteKey);

  while (order.length > WINDOW_MINUTES) {
    const evictKey = order.shift();

    if (evictKey === undefined) {
      break;
    }

    const bucket = buckets.get(evictKey);

    if (! bucket) {
      continue;
    }

    for (const k of bucket) {
      seen.delete(k);
    }

    buckets.delete(evictKey);
  }
}

/**
 * Produce a stable deduplication key for a message.
 * Key = "<action>|<sha256 over all rows with _date_ blanked, in column order>".
 */
function messageKey(msg: Message, ctx: CheckContext): string {
  const cols = ctx.header?.columns ?? Object.keys(msg.rows[0] ?? {});
  const hash = crypto.createHash('sha256');

  for (const row of msg.rows) {
    for (const col of cols) {
      const val = col === '_date_' ? '' : (row[col] ?? '');

      hash.update(val);
      hash.update('\x1f');
    }

    hash.update('\n');
  }

  return `${msg.action}|${hash.digest('hex')}`;
}

// ── Test exports ──────────────────────────────────────────────────────────────

export const _test_messageKey      = messageKey;
export const _test_advanceWindow   = advanceWindow;
export const _test_canonicalMinute = canonicalMinute;
