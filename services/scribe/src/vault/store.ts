import { logger } from '@devvir/service-kit';

type Row       = Record<string, unknown>;
type FileState = 'open' | 'closed';

const RETRY_DELAY_MS = 5_000;

export interface StoreService {
  writeRows(table: string, date: string, rows: Row[]): Promise<void>;
  closeFile(table: string, date: string): Promise<void>;
  deleteFile(table: string, date: string): Promise<void>;
  listFiles(table: string): Promise<Record<string, FileState>>;
}

export const createStoreService = (vaultUrl: string, retryDelayMs = RETRY_DELAY_MS): StoreService => {
  const vaultFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    while (true) {
      let res: Response;

      try {
        res = await fetch(url, init);
      } catch (err) {
        logger.warn({ url }, `Vault unreachable — retrying in ${retryDelayMs / 1000}s`);
        await new Promise(r => setTimeout(r, retryDelayMs));
        continue;
      }

      if (res.status === 429) {
        logger.info({ url }, `Vault throttled this path — retrying in ${retryDelayMs / 1000}s`);
        await new Promise(r => setTimeout(r, retryDelayMs));

        continue;
      }

      if (res.status === 503) {
        logger.warn({ url }, `Vault storage unhealthy — retrying in ${retryDelayMs / 1000}s`);
        await new Promise(r => setTimeout(r, retryDelayMs));

        continue;
      }

      return res;
    }
  };

  return {
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
  };
};
