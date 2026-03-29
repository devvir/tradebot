import { logger } from '@devvir/service-kit';

type Row       = Record<string, unknown>;
type FileState = 'open' | 'closed';

const RETRY_DELAY_MS = 5_000;

const vaultFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  while (true) {
    try {
      return await fetch(url, init);
    } catch (err) {
      logger.warn({ url }, `Vault unreachable — retrying in ${RETRY_DELAY_MS / 1000}s`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
};

export interface StoreService {
  writeRows(table: string, date: string, rows: Row[]): Promise<void>;
  closeFile(table: string, date: string): Promise<void>;
  deleteFile(table: string, date: string): Promise<void>;
  listFiles(table: string): Promise<Record<string, FileState>>;
}

export const createStoreService = (vaultUrl: string): StoreService => ({
  writeRows: async (table, date, rows) => {
    const res = await vaultFetch(`${vaultUrl}/files/${table}/${date}/rows`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(rows),
    });

    if (! res.ok) throw new Error(`Vault write failed for ${table}/${date}: HTTP ${res.status}`);
  },

  closeFile: async (table, date) => {
    const res = await vaultFetch(`${vaultUrl}/files/${table}/${date}/close`, { method: 'POST' });

    if (! res.ok && res.status !== 404) throw new Error(`Vault close failed for ${table}/${date}: HTTP ${res.status}`);
  },

  deleteFile: async (table, date) => {
    const res = await vaultFetch(`${vaultUrl}/files/${table}/${date}`, { method: 'DELETE' });

    if (! res.ok && res.status !== 404) throw new Error(`Vault delete failed for ${table}/${date}: HTTP ${res.status}`);
  },

  listFiles: async (table) => {
    const res = await vaultFetch(`${vaultUrl}/files/${table}`);

    if (res.status === 404) return {};
    if (! res.ok) throw new Error(`Vault list failed for ${table}: HTTP ${res.status}`);

    return res.json() as Promise<Record<string, FileState>>;
  },
});
