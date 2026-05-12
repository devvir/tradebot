import { logger } from '@devvir/service-kit';
import type { BitmexTable, TableBuffer, WsMessage } from '../types';
import { writeToVault, closeVaultFile, waitForVault } from './vault';

const FLUSH_SIZE     = 1_000;
const FLUSH_INTERVAL = 1_000;
const CLOSE_DELAY_MS = 60 * 60 * 1_000;

export const createBuffer = (vaultUrl: string, suffix: string) => {
  const buffers    = new Map<string, TableBuffer>();
  // Per-table promise chain — ensures all operations for a given table execute
  // in order, one at a time. Flushes are serialized; the day-close is always
  // the last operation for a given date's data. Eliminates out-of-order CSV
  // writes and prevents stray "zombie" files created when an inflight flush
  // races with vault's gzip-and-seal.
  const tableChain = new Map<string, Promise<void>>();

  // Highest seen date per table, driven by the x-bitmex-published-at header.
  // When a table sees a strictly higher date, the previous date's file is
  // scheduled to close after 1 hour.
  const tableCurrentDay = new Map<BitmexTable, string>();

  // ── Vault back-pressure ───────────────────────────────────────────────────

  let stuckWrites = 0;
  let gateResolve: (() => void) | null = null;
  let gate: Promise<void> = Promise.resolve();

  const pressureOn = (): void => {
    stuckWrites++;

    if (stuckWrites === 1)
      gate = new Promise<void>((r) => { gateResolve = r; });
  };

  const pressureOff = (): void => {
    stuckWrites = Math.max(0, stuckWrites - 1);

    if (stuckWrites === 0 && gateResolve) {
      gateResolve();
      gateResolve = null;
    }
  };

  // ── Buffer helpers ────────────────────────────────────────────────────────

  const getBuffer = (table: string): TableBuffer => {
    if (! buffers.has(table))
      buffers.set(table, { messages: [], timer: null });

    return buffers.get(table)!;
  };

  const cancelTimer = (buf: TableBuffer): void => {
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  };

  // ── Writing to vault ──────────────────────────────────────────────────────

  const writeWithRetry = async (table: BitmexTable, day: string, messages: WsMessage[]): Promise<void> => {
    let pressured = false;

    while (! await writeToVault(vaultUrl, table, day, messages, suffix)) {
      if (! pressured) { pressured = true; pressureOn(); }
      await waitForVault();
    }

    if (pressured) pressureOff();
  };

  // ── Per-table chain ───────────────────────────────────────────────────────

  // Appends an async task to the end of a table's chain. The task receives no
  // arguments — it must capture everything it needs from the call site so that
  // values like `day` and `messages` are frozen at enqueue time, not evaluated
  // when the chain eventually executes the task.
  const enqueue = (table: BitmexTable, task: () => Promise<void>): void => {
    const prev = tableChain.get(table) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch(err => logger.error({ err, table }, 'Write error'));
    tableChain.set(table, next);
  };

  // ── Flushing ──────────────────────────────────────────────────────────────

  // Groups messages by the date in their `date` field and enqueues one write per day.
  const flushMessages = (table: BitmexTable, messages: WsMessage[]): void => {
    if (messages.length === 0) return;

    const byDay = new Map<string, WsMessage[]>();

    for (const msg of messages) {
      const day = dayOf(msg.date);

      if (! byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(msg);
    }

    for (const [day, dayMessages] of byDay) {
      enqueue(table, () => writeWithRetry(table, day, dayMessages));
    }
  };

  const flushTableAsync = (table: BitmexTable, buf: TableBuffer): void => {
    cancelTimer(buf);
    flushMessages(table, buf.messages.splice(0));
  };

  const scheduleFlush = (table: string, buf: TableBuffer): void => {
    if (buf.timer) return;

    buf.timer = setTimeout(() => {
      buf.timer = null;
      flushTableAsync(table as BitmexTable, buf);
    }, FLUSH_INTERVAL);
  };

  // ── Day boundary (per-table) ──────────────────────────────────────────────

  // Keyed by "${table}:${date}" to avoid scheduling the same file twice.
  const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // When a table sees a strictly higher date, the previous date's file is
  // scheduled to close 1 hour later. Lower or equal dates are just processed.
  const scheduleClose = (table: BitmexTable, date: string): void => {
    const key = `${table}:${date}`;

    if (closeTimers.has(key)) return;

    closeTimers.set(key, setTimeout(() => {
      closeTimers.delete(key);
      // Fire independently — NOT on the per-table chain. The close of an old
      // day must never block writes for the new day. Vault coordinates its own
      // drain/close ordering via the `closing` gate.
      closeVaultFile(vaultUrl, table, date, suffix).catch(err =>
        logger.error({ err, table, date }, 'Close failed'),
      );
    }, CLOSE_DELAY_MS));

    logger.info({ table, date }, 'Day bucket closing in 1 hour');
  };

  const updateDayBoundary = (table: BitmexTable, day: string): void => {
    const current = tableCurrentDay.get(table);

    if (! current) {
      tableCurrentDay.set(table, day);
      return;
    }

    if (day > current) {
      scheduleClose(table, current);
      tableCurrentDay.set(table, day);
    }

    // Lower or equal: do nothing — just process the message.
  };

  // ── Buffering ─────────────────────────────────────────────────────────────

  const appendAndMaybeFlush = (table: BitmexTable, msg: WsMessage): void => {
    const buf = getBuffer(table);

    buf.messages.push(msg);

    if (buf.messages.length >= FLUSH_SIZE)
      return flushTableAsync(table, buf);

    scheduleFlush(table, buf);
  };

  // ── Main entry point ──────────────────────────────────────────────────────

  const receive = async (table: BitmexTable, msg: WsMessage): Promise<void> => {
    await gate;

    const day = dayOf(msg.date);
    updateDayBoundary(table, day);
    appendAndMaybeFlush(table, msg);
  };

  // ── Shutdown ──────────────────────────────────────────────────────────────

  const flushAll = async (): Promise<void> => {
    for (const timer of closeTimers.values()) clearTimeout(timer);
    closeTimers.clear();

    for (const [table, buf] of buffers.entries())
      flushTableAsync(table as BitmexTable, buf);

    await Promise.all([...tableChain.values()]);
  };

  return { receive, flushAll };
};

// Extracts YYYYMMDD from a datetime string via slice — no Date object needed.
const dayOf = (ts: string): string => ts.slice(0, 10).replace(/-/g, '');
