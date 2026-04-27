import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerRoutes, _test_resetClosing } from '../../src/server/routes';
import { NotFoundError } from '../../src/fs/errors';

// ── Mock the data and fs layers ───────────────────────────────────────────────

vi.mock('../../src/data/decode', () => ({
  decodeFile: vi.fn(),
}));

vi.mock('../../src/fs/reader', () => ({
  streamLines: vi.fn(),
  listFiles:   vi.fn(),
  listTables:  vi.fn(),
  fileState:   vi.fn(),
}));

vi.mock('../../src/fs/writer', () => ({
  storeFile:  vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock('../../src/fs/health', () => ({
  isHealthy:        vi.fn(() => true),
  getFailureReason: vi.fn(() => null),
}));

vi.mock('../../src/data/buffers', () => ({
  buffers: { get: vi.fn(() => ({ flush: vi.fn(), pushMany: vi.fn() })) },
}));

vi.mock('../../src/data/encode', () => ({
  encode: vi.fn(() => ['encoded-line']),
}));

vi.mock('../../src/data/close', () => ({
  closeBucket: vi.fn(() => Promise.resolve()),
}));

import { decodeFile } from '../../src/data/decode';
import { streamLines, listFiles, listTables, fileState } from '../../src/fs/reader';
import { storeFile, deleteFile } from '../../src/fs/writer';
import { isHealthy, getFailureReason } from '../../src/fs/health';
import { buffers } from '../../src/data/buffers';
import { encode } from '../../src/data/encode';
import { closeBucket } from '../../src/data/close';

/** Make an async generator from an array of strings. */
async function* fromLines(lines: string[]) {
  for (const l of lines) yield l;
}

const app = express();
app.use(express.json());
registerRoutes(app);

beforeEach(() => {
  vi.clearAllMocks();
  _test_resetClosing();

  // Default mock returns — individual tests can override.
  vi.mocked(isHealthy).mockReturnValue(true);
  vi.mocked(fileState).mockReturnValue('none');
  vi.mocked(buffers.get).mockReturnValue({ flush: vi.fn(), pushMany: vi.fn() } as never);
  vi.mocked(encode).mockReturnValue(['encoded-line']);
  vi.mocked(closeBucket).mockResolvedValue(undefined);
});

// ── PUT /files/:table/:date ───────────────────────────────────────────────────

describe('PUT /files/:table/:date', () => {
  it('stores the file and returns 204', async () => {
    vi.mocked(fileState).mockReturnValue('none');
    vi.mocked(storeFile).mockResolvedValue(undefined);

    const res = await request(app)
      .put('/files/trade/2023-02-01')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('fake gzip bytes'));

    expect(res.status).toBe(204);
    expect(storeFile).toHaveBeenCalledWith('trade', '2023-02-01', expect.anything());
  });

  it('returns 409 when the file is already closed', async () => {
    vi.mocked(fileState).mockReturnValue('closed');

    const res = await request(app)
      .put('/files/trade/2023-02-01')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(409);
    expect(storeFile).not.toHaveBeenCalled();
  });

  it('discards the open file and proceeds when a prior interrupted upload exists', async () => {
    const flush = vi.fn();
    vi.mocked(buffers.get).mockReturnValue({ flush, pushMany: vi.fn() } as never);
    vi.mocked(fileState).mockReturnValue('open');
    vi.mocked(storeFile).mockResolvedValue(undefined);

    const res = await request(app)
      .put('/files/trade/2023-02-01')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(204);
    expect(flush).toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith('trade', '2023-02-01');
    expect(storeFile).toHaveBeenCalled();
  });

  it('returns 500 when storeFile throws', async () => {
    vi.mocked(fileState).mockReturnValue('none');
    vi.mocked(storeFile).mockRejectedValue(new Error('disk full'));

    const res = await request(app)
      .put('/files/trade/2023-02-01')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(500);
  });
});

// ── DELETE /files/:table/:date ────────────────────────────────────────────────

describe('DELETE /files/:table/:date', () => {
  it('flushes the buffer, deletes the file, and returns 204', async () => {
    const flush = vi.fn();
    vi.mocked(buffers.get).mockReturnValue({ flush } as never);

    const res = await request(app).delete('/files/trade/2023-02-01');

    expect(res.status).toBe(204);
    expect(flush).toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledWith('trade', '2023-02-01');
  });
});

// ── GET /tables ───────────────────────────────────────────────────────────────

describe('GET /tables', () => {
  it('returns the list of tables', async () => {
    vi.mocked(listTables).mockReturnValue(['trade', 'quote']);
    const res = await request(app).get('/tables');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['trade', 'quote']);
  });
});

// ── GET /files/:table ─────────────────────────────────────────────────────────

describe('GET /files/:table', () => {
  it('returns the file listing for a table', async () => {
    vi.mocked(listFiles).mockReturnValue({ '2023-02-01': 'closed', '2023-02-02': 'open' });
    const res = await request(app).get('/files/trade');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '2023-02-01': 'closed', '2023-02-02': 'open' });
  });

  it('returns 404 when the table directory does not exist', async () => {
    vi.mocked(listFiles).mockReturnValue(null);
    const res = await request(app).get('/files/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns an empty object when the table directory exists but has no files', async () => {
    vi.mocked(listFiles).mockReturnValue({});
    const res = await request(app).get('/files/trade');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});

// ── GET /files/:table/:date ───────────────────────────────────────────────────

describe('GET /files/:table/:date', () => {
  it('streams NDJSON rows', async () => {
    const line1 = JSON.stringify({ symbol: 'XBTUSD' }) + '\n';
    const line2 = JSON.stringify({ symbol: 'ETHUSD' }) + '\n';

    vi.mocked(decodeFile).mockReturnValue(
      fromLines([line1, line2]) as ReturnType<typeof decodeFile>,
    );

    const res = await request(app).get('/files/trade/2023-02-01');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch('application/x-ndjson');
    expect(res.text).toBe(line1 + line2);
  });

  it('returns 404 when the file does not exist', async () => {
    async function* throwNotFound() { throw new NotFoundError('No closed file for trade/2023-02-01'); yield ''; }

    vi.mocked(decodeFile).mockReturnValue(throwNotFound() as ReturnType<typeof decodeFile>);

    const res = await request(app).get('/files/trade/2023-02-01');

    expect(res.status).toBe(404);
  });

  it('passes the skip query param to decodeFile', async () => {
    vi.mocked(decodeFile).mockReturnValue(fromLines([]) as ReturnType<typeof decodeFile>);

    await request(app).get('/files/trade/2023-02-01?skip=5');

    expect(decodeFile).toHaveBeenCalledWith('trade', '2023-02-01', 5);
  });
});

// ── GET /files/:table/:date/headers ───────────────────────────────────────────

describe('GET /files/:table/:date/headers', () => {
  it('returns the columns from the first line', async () => {
    vi.mocked(streamLines).mockReturnValue(
      fromLines(['symbol,price,size']) as ReturnType<typeof streamLines>,
    );

    const res = await request(app).get('/files/trade/2023-02-01/headers');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ columns: ['symbol', 'price', 'size'] });
  });

  it('returns 404 when the file has no content', async () => {
    vi.mocked(streamLines).mockReturnValue(fromLines([]) as ReturnType<typeof streamLines>);

    const res = await request(app).get('/files/trade/2023-02-01/headers');

    expect(res.status).toBe(404);
  });

  it('returns 404 when the file does not exist', async () => {
    async function* throwNotFound(): AsyncGenerator<string> { throw new NotFoundError('missing'); yield ''; }

    vi.mocked(streamLines).mockReturnValue(throwNotFound() as ReturnType<typeof streamLines>);

    const res = await request(app).get('/files/trade/2023-02-01/headers');

    expect(res.status).toBe(404);
  });
});

// ── POST /files/:table/:date/rows ─────────────────────────────────────────────

describe('POST /files/:table/:date/rows', () => {
  it('encodes each item and pushes to the buffer; returns 202', async () => {
    const pushMany = vi.fn();
    vi.mocked(buffers.get).mockReturnValue({ flush: vi.fn(), pushMany } as never);
    vi.mocked(encode)
      .mockReturnValueOnce(['line-a'])
      .mockReturnValueOnce(['line-b1', 'line-b2']);

    const res = await request(app)
      .post('/files/trade/2023-02-01/rows')
      .send([{ symbol: 'X' }, { action: 'insert', date: 't', data: [{ a: 1 }, { a: 2 }] }]);

    expect(res.status).toBe(202);
    expect(encode).toHaveBeenNthCalledWith(1, 'trade', { symbol: 'X' });
    expect(encode).toHaveBeenNthCalledWith(2, 'trade', { action: 'insert', date: 't', data: [{ a: 1 }, { a: 2 }] });
    expect(pushMany).toHaveBeenNthCalledWith(1, ['line-a']);
    expect(pushMany).toHaveBeenNthCalledWith(2, ['line-b1', 'line-b2']);
  });

  it('accepts a single object (not wrapped in an array)', async () => {
    const res = await request(app)
      .post('/files/trade/2023-02-01/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(202);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when storage is unhealthy', async () => {
    vi.mocked(isHealthy).mockReturnValue(false);
    vi.mocked(getFailureReason).mockReturnValue('disk full');

    const res = await request(app)
      .post('/files/trade/2023-02-01/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(503);
    expect(encode).not.toHaveBeenCalled();
  });

  it('returns 409 when fileState is closed', async () => {
    vi.mocked(fileState).mockReturnValue('closed');

    const res = await request(app)
      .post('/files/trade/2023-02-01/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(409);
    expect(encode).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty array body', async () => {
    const res = await request(app)
      .post('/files/trade/2023-02-01/rows')
      .send([]);

    expect(res.status).toBe(400);
  });

  it('returns 400 when an array contains a non-object item', async () => {
    const res = await request(app)
      .post('/files/trade/2023-02-01/rows')
      .send([{ a: 1 }, 'oops']);

    expect(res.status).toBe(400);
  });

  it('returns 400 when a WS message is missing the data array', async () => {
    const res = await request(app)
      .post('/files/trade/2023-02-01/rows')
      .send({ action: 'insert', date: 't' });

    expect(res.status).toBe(400);
    expect(encode).not.toHaveBeenCalled();
  });

  it('rejects further writes after a close has been requested', async () => {
    await request(app).post('/files/trade/2023-02-01/close').send();

    const res = await request(app)
      .post('/files/trade/2023-02-01/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(409);
  });
});

// ── POST /files/:table/:date/close ────────────────────────────────────────────

describe('POST /files/:table/:date/close', () => {
  it('returns 202 and invokes closeBucket', async () => {
    const res = await request(app).post('/files/trade/2023-02-01/close').send();

    expect(res.status).toBe(202);
    expect(closeBucket).toHaveBeenCalledWith('trade', '2023-02-01');
  });

  it('still returns 202 even when closeBucket rejects (fire-and-forget)', async () => {
    vi.mocked(closeBucket).mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/files/trade/2023-02-01/close').send();

    expect(res.status).toBe(202);
  });
});
