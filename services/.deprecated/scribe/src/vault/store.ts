import type { FetchClientHandle } from '@devvir/service-kit';

type Row       = Record<string, unknown>;
type FileState = 'open' | 'closed';

export interface StoreService {
  writeRows(table: string, date: string, rows: Row[]): Promise<void>;
  closeFile(table: string, date: string): Promise<void>;
  deleteFile(table: string, date: string): Promise<void>;
  listFiles(table: string): Promise<Record<string, FileState>>;
}

/**
 * Vault access for scribe. Retry against a recovering vault (429/503/network,
 * uncapped) and unreachable/recovered logging are handled by the `vault`
 * client — see service.ts.
 */
export const createStoreService = (vault: FetchClientHandle): StoreService => ({
  writeRows: async (table, date, rows) => {
    const res = await vault.request(`/files/${table}/${date}/rows`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(rows),
    });

    if (! res.ok) throw new Error(`Vault write failed for ${table}/${date}: HTTP ${res.status}`);
  },

  closeFile: async (table, date) => {
    const res = await vault.request(`/files/${table}/${date}/close`, { method: 'POST' });

    if (! res.ok && res.status !== 404) throw new Error(`Vault close failed for ${table}/${date}: HTTP ${res.status}`);
  },

  deleteFile: async (table, date) => {
    const res = await vault.request(`/files/${table}/${date}`, { method: 'DELETE' });

    if (! res.ok && res.status !== 404) throw new Error(`Vault delete failed for ${table}/${date}: HTTP ${res.status}`);
  },

  listFiles: async (table) => {
    const files = await vault.get<Record<string, FileState>>(`/files/${table}`, { passThrough: [404] });

    return files ?? {};
  },
});
