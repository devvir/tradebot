import { BitmexDataItem, BitmexDataMessage, BitmexPartial, BitmexTable } from '@tradebot/types';

export type { BitmexDataItem, BitmexDataItemWithSymbol, BitmexPartial, BitmexTable } from '@tradebot/types';

export interface State {
  snapshots: Record<BitmexTable, Snapshot>;
}

export type BitmexMessage = BitmexDataMessage;
export type Message = BitmexMessage & { counter: number; };

type SnapshotBase = Omit<BitmexPartial, 'data'> & { counter: number; };
type SnapshotData = { data: BitmexMessage['data'] | SnapshotIndexedData };
export type SnapshotIndexedData = Map<string, BitmexDataItem>;
export type Snapshot = SnapshotBase & SnapshotData;