/**
 * Per-table wire-envelope templates for WS messages.
 *
 * Today's reconstruct path produces a structured object that gets
 * JSON.stringify'd at flush time, allocating intermediate POJOs and a
 * large output buffer per batch. At sustained throughput the V8 hidden-
 * class churn and GC pressure are visible as throughput variance and
 * event-loop pauses that don't show up in flat CPU%.
 *
 * The template path produces the wire JSON directly as a string —
 * `assemble` extracts the `data` array slice from the raw envelope and
 * splices it into a per-table template that already carries the fixed
 * `keys` / `types` / `filter` strings (and chat's keys/filterKey
 * overrides). All the fixed-per-table content is stringified once, at
 * module load. Per-message work is just two string concatenations plus
 * the variable timestamp.
 *
 * Templates cover the common-case actions: any explicit verb
 * (`insert` / `update` / `delete` / …) through `simple()`, and the
 * decoration-bearing `partial` action through `partial()`. The rare
 * symbol-qualified `partial:<symbol>` case is handled separately by
 * `assemble` via parse → reconstruct → stringify, because the filter
 * symbol varies per message and isn't worth template-parametrizing.
 */

import { TABLE_SPECS } from '@tradebot/utils';
import type { BitmexTable } from '@tradebot/types';
import { UnknownTableError } from './reconstruct';

export interface WsTemplate {
  /** Build the wire JSON for a non-partial action (insert / update / delete / …). */
  simple(action: string, timestamp: string, dataSlice: string): string;

  /** Build the wire JSON for a plain `partial` action (no symbol qualifier). */
  partial(timestamp: string, dataSlice: string): string;
}

// ── Public API ────────────────────────────────────────────────────────────────

export const templateFor = (table: BitmexTable): WsTemplate => {
  const t = templates.get(table);

  if (! t) throw new UnknownTableError(table);

  return t;
};

// ── Build templates once at module load ───────────────────────────────────────

const templates: Map<BitmexTable, WsTemplate> = new Map();

for (const [tableName, spec] of Object.entries(TABLE_SPECS)) {
  const table  = tableName as BitmexTable;
  const isChat = table === 'chat';

  /**
   * For chat, `keys` is always `['id']` and `filterKey` is always
   * `'channelID'` — both on partials AND on plain action messages. For
   * everything else, decoration only appears on partials.
   */
  const typesJson  = JSON.stringify(spec.types);
  const filterJson = JSON.stringify(spec.filter);
  const keysJson   = JSON.stringify(spec.keys);

  const partialTail = isChat
    ? `,"types":${typesJson},"filter":${filterJson},"keys":["id"],"filterKey":"channelID"`
    : `,"types":${typesJson},"filter":${filterJson},"keys":${keysJson}`;

  const simpleTail = isChat
    ? `,"keys":["id"],"filterKey":"channelID"`
    : '';

  templates.set(table, {
    simple: (action, timestamp, dataSlice) =>
      `{"table":"${table}","action":"${action}","data":[${dataSlice}],"timestamp":"${timestamp}"${simpleTail}}`,

    partial: (timestamp, dataSlice) =>
      `{"table":"${table}","action":"partial","data":[${dataSlice}],"timestamp":"${timestamp}"${partialTail}}`,
  });
}
