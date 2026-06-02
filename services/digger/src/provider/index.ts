import type { FetchClientHandle } from '@devvir/service-kit';
import type { BitmexTable } from '@tradebot/types';
import type { DataItem, RestParams } from '../core/types';
import type { StreamPage, PartialResult } from './types';

/**
 * The provider seam — the ONLY place in digger that knows the provider's HTTP
 * shape. Reader and rest depend on this surface, not on URLs, so swapping the
 * data source (e.g. the future intermediate service) is a change here only.
 *
 * Two clients: a ws-firehose provider for the stream, and a dedicated rest
 * provider so heavy REST scans never contend with the firehose.
 */
export class Provider {
  constructor(
    private readonly wsClient:   FetchClientHandle,
    private readonly restClient: FetchClientHandle,
  ) {}

  /** The partial to apply on cold-activate + the cursor to begin paging the stream. */
  async partial(table: BitmexTable, beforeMs: number): Promise<PartialResult> {
    const res = await this.wsClient.get<PartialResult>(`/ws/${table}/partial?before=${beforeMs}`);

    return res ?? { partial: null, cursor: null };
  }

  /** The next page of wire messages after an opaque cursor. */
  async stream(table: BitmexTable, after: number, limit: number): Promise<StreamPage> {
    const res = await this.wsClient.get<StreamPage>(`/ws/${table}?after=${after}&limit=${limit}`);

    return res ?? { messages: [], cursor: null, exhausted: true };
  }

  /** Time-series records for the REST surface (flat tables). */
  async records(table: BitmexTable, params: RestParams): Promise<DataItem[]> {
    const res = await this.restClient.get<DataItem[]>(`/rest/${table}?${toQuery(params)}`);

    return res ?? [];
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

const toQuery = (p: RestParams): string => {
  const q = new URLSearchParams();

  q.set('count',   String(p.count));
  q.set('start',   String(p.start));
  q.set('reverse', String(p.reverse));

  if (p.symbol)                  q.set('symbol',    p.symbol);
  if (p.startTime !== undefined) q.set('startTime', String(p.startTime));
  if (p.endTime   !== undefined) q.set('endTime',   String(p.endTime));
  if (p.columns)                 q.set('columns',   p.columns.join(','));
  if (p.depth     !== undefined) q.set('depth',     String(p.depth));

  return q.toString();
};
