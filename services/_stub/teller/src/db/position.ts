import { getMongo, getConfig } from '../store';
import type { PositionDoc } from '../types';

const col = () => getMongo().db(getConfig().database).collection<PositionDoc>('position');

export async function upsert(position: PositionDoc): Promise<void> {
  await col().replaceOne(
    { accountId: position.accountId, symbol: position.symbol, strategy: position.strategy },
    position,
    { upsert: true },
  );
}

export async function findByAccount(accountId: string): Promise<PositionDoc[]> {
  return col().find({ accountId }).toArray();
}
