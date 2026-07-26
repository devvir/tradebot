import { getMongo, getConfig } from '../store';
import type { MarginDoc } from '../types';

const col = () => getMongo().db(getConfig().database).collection<MarginDoc>('margin');

export async function upsert(margin: MarginDoc): Promise<void> {
  await col().replaceOne(
    { accountId: margin.accountId },
    margin,
    { upsert: true },
  );
}

export async function findByAccount(accountId: string): Promise<MarginDoc | null> {
  return col().findOne({ accountId });
}
