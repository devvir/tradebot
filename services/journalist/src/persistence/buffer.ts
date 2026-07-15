import { logger } from '@devvir/service-kit';
import type { TableBuffer, WsMessage } from '../types';
import { writeToVault, waitForVault } from './vault';

const FLUSH_SIZE     = 1_000;
const FLUSH_INTERVAL = 1_000;

export const createBuffer = (vaultUrl: string, suffix: string) => {
  const buffers    = new Map<string, TableBuffer>();
  // Per-table promise chain — ensures all operations for a given table execute
  // in order, one at a time. Eliminates out-of-order CSV writes.
  const tableChain = new Map<string, Promise<void>>();

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

  // The `.tail` safety valve: if a day's bucket is already sealed when a late
  // message arrives for it, the rows are diverted to a sibling `<suffix>.tail`
  // file instead of being dropped. Such a file is never closed, so a write to
  // it can only succeed or hit a down vault — never `closed`. Seeing one means
  // an assumption broke (a message arrived more than the close grace period
  // late) and the data is preserved for manual handling.
  const tailSuffix = suffix ? `${suffix}.tail` : 'tail';

  const writeWithRetry = async (table: string, day: string, messages: WsMessage[]): Promise<void> => {
    let pressured       = false;
    let activeSuffix    = suffix;

    while (true) {
      const result = await writeToVault(vaultUrl, table, day, messages, activeSuffix);

      if (result === 'ok') break;

      if (result === 'closed') {
        logger.warn({ table, day, count: messages.length }, 'Bucket sealed — diverting late rows to .tail');
        activeSuffix = tailSuffix;
        continue;
      }

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
  const enqueue = (table: string, task: () => Promise<void>): void => {
    const prev = tableChain.get(table) ?? Promise.resolve();
    const next = prev
      .then(task)
      .catch(err => logger.error({ err, table }, 'Write error'));
    tableChain.set(table, next);
  };

  // ── Flushing ──────────────────────────────────────────────────────────────

  // Groups buffered entries by day and enqueues one write per day.
  const flushEntries = (table: string, entries: { day: string; msg: WsMessage }[]): void => {
    if (entries.length === 0) return;

    const byDay = new Map<string, WsMessage[]>();

    for (const { day, msg } of entries) {
      if (! byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(msg);
    }

    for (const [day, dayMessages] of byDay) {
      enqueue(table, () => writeWithRetry(table, day, dayMessages));
    }
  };

  const flushTableAsync = (table: string, buf: TableBuffer): void => {
    cancelTimer(buf);
    flushEntries(table, buf.messages.splice(0));
  };

  const scheduleFlush = (table: string, buf: TableBuffer): void => {
    if (buf.timer) return;

    buf.timer = setTimeout(() => {
      buf.timer = null;
      flushTableAsync(table, buf);
    }, FLUSH_INTERVAL);
  };

  // ── Main entry point ──────────────────────────────────────────────────────

  const receive = async (table: string, day: string, msg: WsMessage): Promise<void> => {
    await gate;

    const buf = getBuffer(table);

    buf.messages.push({ day, msg });

    if (buf.messages.length >= FLUSH_SIZE)
      return flushTableAsync(table, buf);

    scheduleFlush(table, buf);
  };

  // ── Shutdown ──────────────────────────────────────────────────────────────

  const flushAll = async (): Promise<void> => {
    for (const [table, buf] of buffers.entries())
      flushTableAsync(table, buf);

    await Promise.all([...tableChain.values()]);
  };

  return { receive, flushAll };
};
