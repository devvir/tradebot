import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerRoutes } from '../../src/server/routes';
import { markClosing, bucketState, _test_reset as resetBucket } from '../../src/data/bucket';
import { NotFoundError, InvalidUploadError, AlreadyExistsError } from '../../src/fs/errors';

// ── Mock the data and fs layers ───────────────────────────────────────────────

vi.mock('../../src/data/decode', () => ({
  decodeFile: vi.fn(),
}));

vi.mock('../../src/fs/reader', () => ({
  listFiles:  vi.fn(),
  listTables: vi.fn(),
  fileState:  vi.fn(),
}));

vi.mock('../../src/data/parse', () => ({
  createParser: vi.fn(),
}));

vi.mock('../../src/fs/writer', () => ({
  storeFile:     vi.fn(),
  deleteFile:    vi.fn(),
  appendBatch:   vi.fn(),
  isInitialized: vi.fn(() => false),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();

  return { ...actual, stat: vi.fn() };
});

vi.mock('../../src/fs/health', () => ({
  isHealthy:        vi.fn(() => true),
  getFailureReason: vi.fn(() => null),
  isThrottled:      vi.fn(() => false),
}));

vi.mock('../../src/data/buffers', () => ({
  buffers: { get: vi.fn(() => ({ flush: vi.fn(), pushMany: vi.fn() })), remove: vi.fn() },
}));

vi.mock('../../src/data/encode', () => ({
  encode: vi.fn(() => ['encoded-line']),
}));

vi.mock('../../src/data/close', () => ({
  closeBucket: vi.fn(() => Promise.resolve()),
}));

import { decodeFile } from '../../src/data/decode';
import { createParser } from '../../src/data/parse';
import { listFiles, listTables, fileState } from '../../src/fs/reader';
import { storeFile, deleteFile } from '../../src/fs/writer';
import { isHealthy, getFailureReason, isThrottled } from '../../src/fs/health';
import { buffers } from '../../src/data/buffers';
import { encode } from '../../src/data/encode';
import { closeBucket } from '../../src/data/close';
import { stat } from 'fs/promises';
import { closedPath, openPath } from '../../src/fs/paths';

/** Make an async generator from an array of strings. */
async function* fromLines(lines: string[]) {
  for (const l of lines) yield l;
}

/** Make an async generator from an array of CSV records. */
async function* fromRecords(records: string[][]) {
  for (const r of records) yield r;
}

const headersRead = vi.fn();

/** Configures createParser so the /headers route streams the given records. */
const mockHeaders = (records: AsyncGenerator<string[]>) => {
  headersRead.mockReturnValue(records);
  vi.mocked(createParser).mockReturnValue({ read: headersRead } as never);
};

const app = express();
app.use(express.json());
registerRoutes(app);

beforeEach(() => {
  vi.clearAllMocks();
  resetBucket();

  // Default mock returns — individual tests can override.
  vi.mocked(isHealthy).mockReturnValue(true);
  vi.mocked(isThrottled).mockReturnValue(false);
  vi.mocked(fileState).mockReturnValue('none');
  vi.mocked(buffers.get).mockReturnValue({ flush: vi.fn(), pushMany: vi.fn() } as never);
  vi.mocked(encode).mockReturnValue(['encoded-line']);
  vi.mocked(closeBucket).mockResolvedValue(undefined);
  vi.mocked(storeFile).mockResolvedValue(undefined);
  vi.mocked(deleteFile).mockResolvedValue(undefined);
});

/** A promise plus the function that resolves it. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });

  return { promise, resolve };
};

/** Starts a request without awaiting it; the returned promise is its response. */
const start = (req: request.Test): Promise<request.Response> => new Promise((resolve, reject) => {
  req.then(resolve, reject);
});

// ── PUT /files/:table/:date ───────────────────────────────────────────────────

describe('PUT /files/:table/:date', () => {
  it('stores the file and returns 204', async () => {
    const res = await request(app)
      .put('/files/trade/20230201')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('fake gzip bytes'));

    expect(res.status).toBe(204);
    expect(storeFile).toHaveBeenCalledWith('trade', '20230201', expect.anything());
  });

  it('accepts a table with no header definition', async () => {
    const res = await request(app)
      .put('/files/someArchive/20230201')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(204);
    expect(storeFile).toHaveBeenCalledWith('someArchive', '20230201', expect.anything());
  });

  it('returns 409 when the file is already closed', async () => {
    vi.mocked(fileState).mockReturnValue('closed');

    const res = await request(app)
      .put('/files/trade/20230201')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(409);
    expect(storeFile).not.toHaveBeenCalled();
  });

  it('discards buffered rows and the open file before storing', async () => {
    vi.mocked(fileState).mockReturnValue('open');

    const res = await request(app)
      .put('/files/trade/20230201')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(204);
    expect(buffers.remove).toHaveBeenCalledWith('trade', '20230201');
    expect(deleteFile).toHaveBeenCalledWith('trade', '20230201');
    expect(vi.mocked(deleteFile).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(storeFile).mock.invocationCallOrder[0]!);
  });

  it('returns 400 when the upload is not a valid gzip stream', async () => {
    vi.mocked(storeFile).mockRejectedValue(new InvalidUploadError('Upload is empty'));

    const res = await request(app).put('/files/trade/20230201').send(Buffer.alloc(0));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Upload is empty');
  });

  it('returns 409 when a closed file appears while uploading', async () => {
    vi.mocked(storeFile).mockRejectedValue(new AlreadyExistsError('exists'));

    const res = await request(app).put('/files/trade/20230201').send(Buffer.from('bytes'));

    expect(res.status).toBe(409);
  });

  it('returns 500 when storeFile throws', async () => {
    vi.mocked(storeFile).mockRejectedValue(new Error('disk full'));

    const res = await request(app)
      .put('/files/trade/20230201')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(500);
  });

  it('returns 409 while the bucket is closing', async () => {
    markClosing('trade', '20230201');

    const res = await request(app).put('/files/trade/20230201').send(Buffer.from('bytes'));

    expect(res.status).toBe(409);
    expect(deleteFile).not.toHaveBeenCalled();
    expect(storeFile).not.toHaveBeenCalled();
  });

  it('returns 409 for a second upload while the first is streaming', async () => {
    const upload = deferred();
    vi.mocked(storeFile).mockReturnValueOnce(upload.promise);

    const first = start(request(app).put('/files/trade/20230201').send(Buffer.from('a')));

    await vi.waitFor(() => expect(storeFile).toHaveBeenCalledTimes(1));
    expect(bucketState('trade', '20230201')).toBe('uploading');

    const second = await request(app).put('/files/trade/20230201').send(Buffer.from('b'));

    expect(second.status).toBe(409);

    upload.resolve();

    expect((await first).status).toBe(204);
    expect(storeFile).toHaveBeenCalledTimes(1);
    expect(bucketState('trade', '20230201')).toBe('idle');
  });
});

// ── DELETE /files/:table/:date ────────────────────────────────────────────────

describe('DELETE /files/:table/:date', () => {
  it('drops the buffer, deletes the open file, and returns 204', async () => {
    const res = await request(app).delete('/files/trade/20230201');

    expect(res.status).toBe(204);
    expect(buffers.remove).toHaveBeenCalledWith('trade', '20230201');
    expect(deleteFile).toHaveBeenCalledWith('trade', '20230201');
  });

  it('answers only once the open file is gone', async () => {
    const removal = deferred();
    vi.mocked(deleteFile).mockReturnValueOnce(removal.promise);

    let answered = false;
    const pending = start(request(app).delete('/files/trade/20230201')).then((r) => { answered = true; return r; });

    await vi.waitFor(() => expect(deleteFile).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(answered).toBe(false);

    removal.resolve();

    expect((await pending).status).toBe(204);
  });

  it('refuses rows, closes, uploads and deletes for the bucket while it runs', async () => {
    const removal = deferred();
    vi.mocked(deleteFile).mockReturnValueOnce(removal.promise);

    const pending = start(request(app).delete('/files/trade/20230201'));

    await vi.waitFor(() => expect(deleteFile).toHaveBeenCalledTimes(1));

    expect((await request(app).post('/files/trade/20230201/rows').send({ symbol: 'X' })).status).toBe(409);
    expect((await request(app).post('/files/trade/20230201/close')).status).toBe(409);
    expect((await request(app).put('/files/trade/20230201').send(Buffer.from('x'))).status).toBe(409);
    expect((await request(app).delete('/files/trade/20230201')).status).toBe(409);
    expect(closeBucket).not.toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalledTimes(1);

    // Other buckets are unaffected.
    expect((await request(app).post('/files/trade/20230202/rows').send({ symbol: 'X' })).status).toBe(202);

    removal.resolve();
    expect((await pending).status).toBe(204);

    expect((await request(app).post('/files/trade/20230201/rows').send({ symbol: 'X' })).status).toBe(202);
  });

  it('returns 409 while the bucket is closing', async () => {
    markClosing('trade', '20230201');

    const res = await request(app).delete('/files/trade/20230201');

    expect(res.status).toBe(409);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('returns 500 when removing the open file fails', async () => {
    vi.mocked(deleteFile).mockRejectedValue(new Error('EACCES'));

    const res = await request(app).delete('/files/trade/20230201');

    expect(res.status).toBe(500);
    expect(bucketState('trade', '20230201')).toBe('idle');
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
  it('returns the file listing for a table (no suffix → bare-date files)', async () => {
    vi.mocked(listFiles).mockReturnValue({ '20230201': 'closed', '20230202': 'open' });

    const res = await request(app).get('/files/trade');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '20230201': 'closed', '20230202': 'open' });
    expect(listFiles).toHaveBeenCalledWith('trade', undefined);
  });

  it('passes the suffix to listFiles when ?suffix= is provided', async () => {
    vi.mocked(listFiles).mockReturnValue({ '20230201.snapshot': 'closed' });

    const res = await request(app).get('/files/trade?suffix=snapshot');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ '20230201.snapshot': 'closed' });
    expect(listFiles).toHaveBeenCalledWith('trade', 'snapshot');
  });

  it('treats an empty ?suffix= the same as no suffix', async () => {
    vi.mocked(listFiles).mockReturnValue({});

    await request(app).get('/files/trade?suffix=');

    expect(listFiles).toHaveBeenCalledWith('trade', undefined);
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
  beforeEach(() => {
    vi.mocked(fileState).mockReturnValue('closed');
  });

  it('streams NDJSON rows', async () => {
    const line1 = JSON.stringify({ symbol: 'XBTUSD' }) + '\n';
    const line2 = JSON.stringify({ symbol: 'ETHUSD' }) + '\n';

    vi.mocked(decodeFile).mockReturnValue(
      fromLines([line1, line2]) as ReturnType<typeof decodeFile>,
    );

    const res = await request(app).get('/files/trade/20230201');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch('application/x-ndjson');
    expect(res.text).toBe(line1 + line2);
  });

  it('returns 404 when the file does not exist', async () => {
    vi.mocked(fileState).mockReturnValue('none');

    const res = await request(app).get('/files/trade/20230201');

    expect(res.status).toBe(404);
    expect(decodeFile).not.toHaveBeenCalled();
  });

  it('returns 404 when the decoder finds no closed file', async () => {
    async function* throwNotFound() { throw new NotFoundError('No closed file for trade/20230201'); yield ''; }

    vi.mocked(decodeFile).mockReturnValue(throwNotFound() as ReturnType<typeof decodeFile>);

    const res = await request(app).get('/files/trade/20230201');

    expect(res.status).toBe(404);
  });

  it.each(['none', 'open'] as const)('returns 404 with ?skip=1 when the file is %s, and the response ends', async (state) => {
    vi.mocked(fileState).mockReturnValue(state);

    const res = await request(app).get('/files/trade/20230201?skip=1').timeout(2_000);

    expect(res.status).toBe(404);
    expect(decodeFile).not.toHaveBeenCalled();
  });

  it('cuts the response when reading fails after headers were sent', async () => {
    async function* failMidway() { yield '{"a":1}\n'; throw new Error('corrupt member'); }

    vi.mocked(decodeFile).mockReturnValue(failMidway() as ReturnType<typeof decodeFile>);

    await expect(request(app).get('/files/trade/20230201?skip=1').timeout(2_000))
      .rejects.toThrow(/aborted|socket hang up|ECONNRESET/);
  });

  it('passes the skip query param to decodeFile', async () => {
    vi.mocked(decodeFile).mockReturnValue(fromLines([]) as ReturnType<typeof decodeFile>);

    await request(app).get('/files/trade/20230201?skip=5');

    expect(decodeFile).toHaveBeenCalledWith('trade', '20230201', 5);
  });
});

// ── GET /files/:table/:date/headers ───────────────────────────────────────────

describe('GET /files/:table/:date/headers', () => {
  it('returns the columns from the first record', async () => {
    mockHeaders(fromRecords([['symbol', 'price', 'size']]));

    const res = await request(app).get('/files/trade/20230201/headers');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ columns: ['symbol', 'price', 'size'] });
  });

  it('returns 404 when the file has no content', async () => {
    mockHeaders(fromRecords([]));

    const res = await request(app).get('/files/trade/20230201/headers');

    expect(res.status).toBe(404);
  });

  it('returns 404 when the file does not exist', async () => {
    async function* throwNotFound(): AsyncGenerator<string[]> { throw new NotFoundError('missing'); yield []; }

    mockHeaders(throwNotFound());

    const res = await request(app).get('/files/trade/20230201/headers');

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
      .post('/files/trade/20230201/rows')
      .send([{ symbol: 'X' }, { action: 'insert', date: 't', data: [{ a: 1 }, { a: 2 }] }]);

    expect(res.status).toBe(202);
    expect(encode).toHaveBeenNthCalledWith(1, 'trade', { symbol: 'X' });
    expect(encode).toHaveBeenNthCalledWith(2, 'trade', { action: 'insert', date: 't', data: [{ a: 1 }, { a: 2 }] });
    expect(pushMany).toHaveBeenNthCalledWith(1, ['line-a']);
    expect(pushMany).toHaveBeenNthCalledWith(2, ['line-b1', 'line-b2']);
  });

  it('accepts a single object (not wrapped in an array)', async () => {
    const res = await request(app)
      .post('/files/trade/20230201/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(202);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when storage is unhealthy', async () => {
    vi.mocked(isHealthy).mockReturnValue(false);
    vi.mocked(getFailureReason).mockReturnValue('disk full');

    const res = await request(app)
      .post('/files/trade/20230201/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(503);
    expect(encode).not.toHaveBeenCalled();
  });

  it('returns 429 when the target file is throttled', async () => {
    vi.mocked(isThrottled).mockImplementation((table, filename) =>
      table === 'trade' && filename === '20230201',
    );

    const res = await request(app)
      .post('/files/trade/20230201/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(429);
    expect(encode).not.toHaveBeenCalled();
  });

  it('does not return 429 for other paths when one is throttled', async () => {
    vi.mocked(isThrottled).mockImplementation((table, filename) =>
      table === 'trade' && filename === '20230201',
    );

    const res = await request(app)
      .post('/files/orderBookL2/20230201/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(202);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when fileState is closed', async () => {
    vi.mocked(fileState).mockReturnValue('closed');

    const res = await request(app)
      .post('/files/trade/20230201/rows')
      .send({ symbol: 'X' });

    expect(res.status).toBe(409);
    expect(encode).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty array body', async () => {
    const res = await request(app)
      .post('/files/trade/20230201/rows')
      .send([]);

    expect(res.status).toBe(400);
  });

  it('returns 400 when an array contains a non-object item', async () => {
    const res = await request(app)
      .post('/files/trade/20230201/rows')
      .send([{ a: 1 }, 'oops']);

    expect(res.status).toBe(400);
  });

  it('returns 400 when a WS message is missing the data array', async () => {
    const res = await request(app)
      .post('/files/trade/20230201/rows')
      .send({ action: 'insert', date: 't' });

    expect(res.status).toBe(400);
    expect(encode).not.toHaveBeenCalled();
  });

  it('returns 409 while the bucket is closing and accepts rows once the close settles', async () => {
    const release = markClosing('trade', '20230201');

    const during = await request(app)
      .post('/files/trade/20230201/rows')
      .send({ symbol: 'X' });

    expect(during.status).toBe(409);

    release();

    const after = await request(app)
      .post('/files/trade/20230201/rows')
      .send({ symbol: 'X' });

    expect(after.status).toBe(202);
  });
});

// ── POST /files/:table/:date/close ────────────────────────────────────────────

describe('POST /files/:table/:date/close', () => {
  it('returns 202 and invokes closeBucket', async () => {
    const res = await request(app).post('/files/trade/20230201/close').send();

    expect(res.status).toBe(202);
    expect(closeBucket).toHaveBeenCalledWith('trade', '20230201');
  });

  it('still returns 202 even when closeBucket rejects (fire-and-forget)', async () => {
    vi.mocked(closeBucket).mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/files/trade/20230201/close').send();

    expect(res.status).toBe(202);
  });
});

// ── ?suffix= plumbing ─────────────────────────────────────────────────────────
//
// The route layer is the only place where date and suffix exist as separate
// concepts. Past this boundary, the rest of vault sees a single `filename`
// argument (`<date>` or `<date>.<suffix>`). These tests assert the composition
// happens correctly on every endpoint that takes `:date`, and that omitting
// `?suffix=` leaves the filename as the bare date.

describe('?suffix= composition', () => {
  it('POST /rows buffers under the suffixed filename', async () => {
    const pushMany = vi.fn();
    vi.mocked(buffers.get).mockReturnValue({ flush: vi.fn(), pushMany } as never);

    const res = await request(app)
      .post('/files/trade/20230201/rows?suffix=snapshot')
      .send({ symbol: 'X' });

    expect(res.status).toBe(202);
    expect(buffers.get).toHaveBeenCalledWith('trade', '20230201.snapshot');
    expect(fileState).toHaveBeenCalledWith('trade', '20230201.snapshot');
  });

  it('POST /close passes the suffixed filename to closeBucket', async () => {
    await request(app).post('/files/trade/20230201/close?suffix=snapshot').send();
    expect(closeBucket).toHaveBeenCalledWith('trade', '20230201.snapshot');
  });

  it('PUT stores under the suffixed filename', async () => {
    vi.mocked(fileState).mockReturnValue('none');
    vi.mocked(storeFile).mockResolvedValue(undefined);

    const res = await request(app)
      .put('/files/trade/20230201?suffix=snapshot')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(204);
    expect(storeFile).toHaveBeenCalledWith('trade', '20230201.snapshot', expect.anything());
  });

  it('DELETE removes the suffixed filename', async () => {
    await request(app).delete('/files/trade/20230201?suffix=snapshot');

    expect(buffers.remove).toHaveBeenCalledWith('trade', '20230201.snapshot');
    expect(deleteFile).toHaveBeenCalledWith('trade', '20230201.snapshot');
  });

  it('GET decodes from the suffixed filename and respects skip', async () => {
    vi.mocked(fileState).mockReturnValue('closed');
    vi.mocked(decodeFile).mockReturnValue(fromLines([]) as ReturnType<typeof decodeFile>);

    await request(app).get('/files/trade/20230201?suffix=snapshot&skip=3');

    expect(decodeFile).toHaveBeenCalledWith('trade', '20230201.snapshot', 3);
  });

  it('GET /headers reads from the suffixed filename', async () => {
    mockHeaders(fromRecords([['col1', 'col2']]));

    const res = await request(app).get('/files/trade/20230201/headers?suffix=snapshot');

    expect(res.status).toBe(200);
    expect(createParser).toHaveBeenCalledWith('trade');
    expect(headersRead).toHaveBeenCalledWith('20230201.snapshot');
  });

  it('omitting ?suffix= uses the plain date as the filename', async () => {
    vi.mocked(fileState).mockReturnValue('closed');
    vi.mocked(decodeFile).mockReturnValue(fromLines([]) as ReturnType<typeof decodeFile>);

    await request(app).get('/files/trade/20230201');

    expect(decodeFile).toHaveBeenCalledWith('trade', '20230201', 0);
  });

  it('an empty ?suffix= is treated the same as no suffix (no trailing dot)', async () => {
    vi.mocked(fileState).mockReturnValue('closed');
    vi.mocked(decodeFile).mockReturnValue(fromLines([]) as ReturnType<typeof decodeFile>);

    await request(app).get('/files/trade/20230201?suffix=');

    expect(decodeFile).toHaveBeenCalledWith('trade', '20230201', 0);
  });
});

// ── Key validation ────────────────────────────────────────────────────────────
//
// `:table`, `:date` and `?suffix=` become filesystem paths. Anything that could
// leave the table's directory, or that names no real day, is refused before it
// reaches the data or fs layers.

describe('key validation', () => {
  type Call = (url: string) => request.Test;

  const routes: Record<string, { call: Call; suffix?: string }> = {
    'PUT':          { call: url => request(app).put(url).send(Buffer.from('x')) },
    'POST rows':    { call: url => request(app).post(url).send({ symbol: 'X' }), suffix: '/rows' },
    'POST close':   { call: url => request(app).post(url), suffix: '/close' },
    'GET':          { call: url => request(app).get(url) },
    'GET headers':  { call: url => request(app).get(url), suffix: '/headers' },
    'DELETE':       { call: url => request(app).delete(url) },
  };

  const untouched = () => {
    expect(fileState).not.toHaveBeenCalled();
    expect(storeFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(decodeFile).not.toHaveBeenCalled();
    expect(createParser).not.toHaveBeenCalled();
    expect(closeBucket).not.toHaveBeenCalled();
    expect(buffers.get).not.toHaveBeenCalled();
  };

  describe.each(Object.entries(routes))('%s', (_name, { call, suffix = '' }) => {
    it.each([
      '..%2Fx',
      '..%2F..%2Flive',
      '.hidden',
      'trade.a.b',
      'trade%00',
    ])('returns 400 for table %s', async (table) => {
      const res = await call(`/files/${table}/20230201${suffix}`);

      expect(res.status).toBe(400);
      untouched();
    });

    it.each([
      'abc',
      '2024-01-01',
      '20241399',
      '20230230',
      '2024010',
      '202401011',
      '2024%2F..%2Fx',
    ])('returns 400 for date %s', async (date) => {
      const res = await call(`/files/trade/${date}${suffix}`);

      expect(res.status).toBe(400);
      untouched();
    });

    it.each([
      '%2F..%2Fx',
      'a.b',
      '..',
      'a%2Fb',
      'x'.repeat(33),
    ])('returns 400 for ?suffix=%s', async (value) => {
      const res = await call(`/files/trade/20230201${suffix}?suffix=${value}`);

      expect(res.status).toBe(400);
      untouched();
    });

    it('returns 400 for a repeated ?suffix=', async () => {
      const res = await call(`/files/trade/20230201${suffix}?suffix=a&suffix=b`);

      expect(res.status).toBe(400);
    });
  });

  it('accepts a leap day and pseudo-table names', async () => {
    vi.mocked(fileState).mockReturnValue('closed');
    vi.mocked(decodeFile).mockReturnValue(fromLines([]) as ReturnType<typeof decodeFile>);

    expect((await request(app).get('/files/orderBookL2.secondary/20240229?suffix=snap_1-a')).status).toBe(200);
    expect(decodeFile).toHaveBeenCalledWith('orderBookL2.secondary', '20240229.snap_1-a', 0);
  });

  it.each([
    ['POST rows',  (url: string) => request(app).post(`${url}/rows`).send({ symbol: 'X' })],
    ['POST close', (url: string) => request(app).post(`${url}/close`)],
    ['DELETE',     (url: string) => request(app).delete(url)],
  ])('%s returns 400 for a table with no header definition', async (_name, call) => {
    const res = await call('/files/someArchive/20230201');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown table/);
  });

  it('GET /files/:table returns 400 for a table that is not a plain name', async () => {
    for (const table of ['..%2F..%2Ftmp', '..', '.']) {
      const res = await request(app).get(`/files/${table}`);

      expect(res.status).toBe(400);
    }

    expect(listFiles).not.toHaveBeenCalled();
  });

  it('GET /files/:table returns 400 for an invalid ?suffix=', async () => {
    const res = await request(app).get('/files/trade?suffix=a.b');

    expect(res.status).toBe(400);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('GET /stats returns 400 for an invalid date', async () => {
    const res = await request(app).get('/stats/trade/2024-01-01');

    expect(res.status).toBe(400);
    expect(fileState).not.toHaveBeenCalled();
  });
});

// ── POST /files/:table/:date/close — lifecycle ────────────────────────────────

describe('POST /files/:table/:date/close while uploading', () => {
  it('returns 409 and does not start a seal', async () => {
    const upload = deferred();
    vi.mocked(storeFile).mockReturnValueOnce(upload.promise);

    const put = start(request(app).put('/files/trade/20230201').send(Buffer.from('a')));

    await vi.waitFor(() => expect(storeFile).toHaveBeenCalled());

    const res = await request(app).post('/files/trade/20230201/close');

    expect(res.status).toBe(409);
    expect(closeBucket).not.toHaveBeenCalled();

    upload.resolve();
    expect((await put).status).toBe(204);
  });
});

// ── GET /stats/:table/:date ───────────────────────────────────────────────────

describe('GET /stats/:table/:date', () => {
  const st = { size: 123, mtimeMs: 1000, birthtimeMs: 900 };
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  it('returns the closed file\'s inode stats', async () => {
    vi.mocked(fileState).mockReturnValue('closed');
    vi.mocked(stat).mockResolvedValue(st as never);

    const res = await request(app).get('/stats/trade/20240101');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: 'closed', size: 123, mtime: 1000, birthtime: 900 });
    expect(stat).toHaveBeenCalledWith(closedPath('trade', '20240101'));
  });

  it('honours ?suffix=', async () => {
    vi.mocked(fileState).mockReturnValue('open');
    vi.mocked(stat).mockResolvedValue(st as never);

    const res = await request(app).get('/stats/trade/20240101?suffix=snapshot');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('open');
    expect(fileState).toHaveBeenCalledWith('trade', '20240101.snapshot');
    expect(stat).toHaveBeenCalledWith(openPath('trade', '20240101.snapshot'));
  });

  it('returns 404 when there is no file', async () => {
    vi.mocked(fileState).mockReturnValue('none');

    const res = await request(app).get('/stats/trade/20240101');

    expect(res.status).toBe(404);
    expect(stat).not.toHaveBeenCalled();
  });

  it('stats the closed file when a seal renames the open one in between', async () => {
    vi.mocked(fileState).mockReturnValueOnce('open').mockReturnValueOnce('closed');
    vi.mocked(stat).mockRejectedValueOnce(enoent()).mockResolvedValueOnce(st as never);

    const res = await request(app).get('/stats/trade/20240101');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('closed');
  });

  it('returns 404 when the file is gone by the time it is statted', async () => {
    vi.mocked(fileState).mockReturnValueOnce('open').mockReturnValueOnce('none');
    vi.mocked(stat).mockRejectedValueOnce(enoent());

    const res = await request(app).get('/stats/trade/20240101');

    expect(res.status).toBe(404);
  });

  it('returns 500 on any other stat failure', async () => {
    vi.mocked(fileState).mockReturnValue('closed');
    vi.mocked(stat).mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));

    const res = await request(app).get('/stats/trade/20240101');

    expect(res.status).toBe(500);
  });
});
