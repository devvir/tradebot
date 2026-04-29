import { getMongo, getConfig } from '../store';
import type { OrderDoc } from '../types';

const col = () => getMongo().db(getConfig().database).collection<OrderDoc>('order');

export async function upsert(order: OrderDoc): Promise<void> {
  await col().replaceOne(
    { orderID: order.orderID },
    order,
    { upsert: true },
  );
}

export async function findByAccount(accountId: string, symbol?: string): Promise<OrderDoc[]> {
  const filter: Record<string, unknown> = { accountId };

  if (symbol) filter.symbol = symbol;

  return col().find(filter).toArray();
}
