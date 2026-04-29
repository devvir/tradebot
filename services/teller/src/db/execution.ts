import { getMongo, getConfig } from '../store';
import type { ExecutionDoc } from '../types';

const col = () => getMongo().db(getConfig().database).collection<ExecutionDoc>('execution');

export async function insert(execution: ExecutionDoc): Promise<void> {
  await col().insertOne(execution as any);
}

export async function findByAccount(
  accountId: string,
  limit:     number = 100,
  reverse:   boolean = true,
): Promise<ExecutionDoc[]> {
  const sort = reverse ? { timestamp: -1 as const } : { timestamp: 1 as const };

  return col().find({ accountId }).sort(sort).limit(limit).toArray();
}
