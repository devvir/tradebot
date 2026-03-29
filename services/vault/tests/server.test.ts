import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Readable } from 'stream';

// ── Mock storage and health ───────────────────────────────────────────────────

vi.mock('../src/health', () => ({
  isHealthy:        vi.fn().mockReturnValue(true),
  getFailureReason: vi.fn().mockReturnValue(null),
}));

vi.mock('../src/storage', () => ({
  insertRow:    vi.fn(),
  insertRows:   vi.fn(),
  isClosing:    vi.fn().mockReturnValue(false),
  isClosed:     vi.fn().mockReturnValue(false),
  storeFile:    vi.fn().mockResolvedValue(undefined),
  closeFile:    vi.fn().mockResolvedValue(undefined),
  dropFile:     vi.fn(),
  streamRows:   vi.fn(),
  readHeaders:  vi.fn().mockResolvedValue(['timestamp', 'symbol', 'price']),
  listFiles:    vi.fn(),
  listTables:   vi.fn().mockReturnValue([]),
  fileExists:   vi.fn().mockReturnValue(false),
  NotFoundError: class NotFoundError extends Error {},
}));

import * as storage from '../src/storage';
import * as health from '../src/health';
import { registerRoutes } from '../src/routes';

// ── Build a test app using the real route registrations ───────────────────────

const buildApp = () => {
  const app = express();

  app.use(express.json());
  registerRoutes(app);

  return app;
};

// ── POST /files/:table/:date/rows ─────────────────────────────────────────────

describe('POST /files/:table/:date/rows', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(storage.insertRow).mockReset();
    vi.mocked(storage.insertRows).mockReset();
    vi.mocked(storage.isClosing).mockReturnValue(false);
    vi.mocked(storage.isClosed).mockReturnValue(false);
    vi.mocked(health.isHealthy).mockReturnValue(true);
  });

  // ── Items (no action field) ──

  it('single item: returns 202 and calls insertRow', async () => {
    const row = { timestamp: '2025-01-01T00:00:00Z', symbol: 'XBTUSD', price: 50000 };

    await request(app)
      .post('/files/trade/20250101/rows')
      .send(row)
      .expect(202);

    expect(storage.insertRow).toHaveBeenCalledWith('trade', '20250101', row);
    expect(storage.insertRows).not.toHaveBeenCalled();
  });

  it('array of items: calls insertRow once per item', async () => {
    const rows = [
      { timestamp: '2025-01-01T00:00:00Z', price: 1 },
      { timestamp: '2025-01-01T00:00:01Z', price: 2 },
    ];

    await request(app)
      .post('/files/trade/20250101/rows')
      .send(rows)
      .expect(202);

    expect(storage.insertRow).toHaveBeenCalledTimes(2);
    expect(storage.insertRow).toHaveBeenCalledWith('trade', '20250101', rows[0]);
    expect(storage.insertRow).toHaveBeenCalledWith('trade', '20250101', rows[1]);
    expect(storage.insertRows).not.toHaveBeenCalled();
  });

  // ── Messages (has action field) ──

  it('single message: augments first data row with _date_ and _action_, calls insertRows', async () => {
    const msg = {
      action: 'insert',
      date:   '2025-01-01T12:00:00.000Z',
      data:   [{ symbol: 'XBTUSD', price: 100 }, { symbol: 'ETHUSD', price: 200 }],
    };

    await request(app)
      .post('/files/connected/20250101/rows')
      .send(msg)
      .expect(202);

    expect(storage.insertRows).toHaveBeenCalledWith('connected', '20250101', [
      { symbol: 'XBTUSD', price: 100, _date_: '2025-01-01T12:00:00.000Z', _action_: 'insert' },
      { symbol: 'ETHUSD', price: 200 },
    ]);
    expect(storage.insertRow).not.toHaveBeenCalled();
  });

  it('message without date: uses wall-clock now() for _date_', async () => {
    const before = new Date().toISOString();
    const msg = { action: 'partial', data: [{ id: 1 }] };

    await request(app)
      .post('/files/connected/20250101/rows')
      .send(msg)
      .expect(202);

    const [, , rows] = vi.mocked(storage.insertRows).mock.calls[0]!;
    const date = (rows[0] as Record<string, unknown>)['_date_'] as string;

    expect(date >= before).toBe(true);
    expect(date <= new Date().toISOString()).toBe(true);
  });

  it('array of messages: processes each independently', async () => {
    const msgs = [
      { action: 'partial', date: '2025-01-01T00:00:00.000Z', data: [{ id: 1 }] },
      { action: 'insert',  date: '2025-01-01T00:01:00.000Z', data: [{ id: 2 }] },
    ];

    await request(app)
      .post('/files/connected/20250101/rows')
      .send(msgs)
      .expect(202);

    expect(storage.insertRows).toHaveBeenCalledTimes(2);
    expect((vi.mocked(storage.insertRows).mock.calls[0]![2][0] as Record<string, unknown>)['_action_']).toBe('partial');
    expect((vi.mocked(storage.insertRows).mock.calls[1]![2][0] as Record<string, unknown>)['_action_']).toBe('insert');
  });

  it('message with empty data array: stores a single metadata-only row', async () => {
    const msg = { action: 'partial', date: '2025-01-01T00:00:00.000Z', data: [] };

    await request(app)
      .post('/files/connected/20250101/rows')
      .send(msg)
      .expect(202);

    expect(storage.insertRows).toHaveBeenCalledWith('connected', '20250101', [
      { _date_: '2025-01-01T00:00:00.000Z', _action_: 'partial' },
    ]);
  });

  it('message missing data field: returns 400', async () => {
    const msg = { action: 'insert' };

    const res = await request(app)
      .post('/files/connected/20250101/rows')
      .send(msg)
      .expect(400);

    expect(res.body.error).toContain('data array');
    expect(storage.insertRows).not.toHaveBeenCalled();
  });

  it('message with data that is not an array: returns 400', async () => {
    const msg = { action: 'insert', data: { id: 1 } };

    const res = await request(app)
      .post('/files/connected/20250101/rows')
      .send(msg)
      .expect(400);

    expect(res.body.error).toContain('data array');
  });

  // ── Validation ──

  it('returns 400 for a non-object body', async () => {
    await request(app)
      .post('/files/trade/20250101/rows')
      .set('Content-Type', 'application/json')
      .send('"just a string"')
      .expect(400);
  });

  it('returns 400 for a nested array body', async () => {
    await request(app)
      .post('/files/trade/20250101/rows')
      .send([[{ id: 1 }]])
      .expect(400);
  });

  // ── Gate checks ──

  it('returns 503 when storage is unhealthy', async () => {
    vi.mocked(health.isHealthy).mockReturnValue(false);
    vi.mocked(health.getFailureReason).mockReturnValue('5 write failures in the last minute');

    const res = await request(app)
      .post('/files/trade/20250101/rows')
      .send({ timestamp: '2025-01-01T00:00:00Z' })
      .expect(503);

    expect(res.body.error).toContain('unhealthy');
    expect(storage.insertRow).not.toHaveBeenCalled();
  });

  it('returns 418 when file is already sealed', async () => {
    vi.mocked(storage.isClosed).mockReturnValue(true);

    const res = await request(app)
      .post('/files/trade/20250101/rows')
      .send({ timestamp: '2025-01-01T00:00:00Z' })
      .expect(418);

    expect(res.body.error).toContain('already closed');
    expect(storage.insertRow).not.toHaveBeenCalled();
  });
});

// ── PUT /files/:table/:date ───────────────────────────────────────────────────

describe('PUT /files/:table/:date', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(storage.fileExists).mockReturnValue(false);
    vi.mocked(storage.storeFile).mockResolvedValue(undefined);
  });

  it('returns 204 on success', async () => {
    await request(app)
      .put('/files/trade/20250101')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('fake gzip bytes'))
      .expect(204);
  });

  it('returns 409 when any file already exists', async () => {
    vi.mocked(storage.fileExists).mockReturnValue(true);

    await request(app)
      .put('/files/trade/20250101')
      .send(Buffer.from('bytes'))
      .expect(409);
  });
});

// ── POST /files/:table/:date/close ────────────────────────────────────────────

describe('POST /files/:table/:date/close', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(storage.isClosed).mockReturnValue(false);
    vi.mocked(storage.isClosing).mockReturnValue(false);
    vi.mocked(storage.fileExists).mockReturnValue(true);
    vi.mocked(storage.closeFile).mockResolvedValue(undefined);
  });

  it('returns 202 and spawns close in background', async () => {
    await request(app)
      .post('/files/trade/20250101/close')
      .expect(202);
  });

  it('returns 404 when no open file exists', async () => {
    vi.mocked(storage.fileExists).mockReturnValue(false);

    await request(app)
      .post('/files/trade/20250101/close')
      .expect(404);
  });
});

// ── DELETE /files/:table/:date ────────────────────────────────────────────────

describe('DELETE /files/:table/:date', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(storage.dropFile).mockReset();
  });

  it('returns 204 on success', async () => {
    await request(app)
      .delete('/files/trade/20250101')
      .expect(204);
  });

  it('returns 404 when no open file exists', async () => {
    vi.mocked(storage.dropFile).mockImplementation(() => {
      throw new storage.NotFoundError('No open file');
    });

    await request(app)
      .delete('/files/trade/20250101')
      .expect(404);
  });
});

// ── GET /files/:table/:date ───────────────────────────────────────────────────

describe('GET /files/:table/:date', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  it('returns 404 when the file does not exist', async () => {
    vi.mocked(storage.streamRows).mockImplementation(() => {
      throw new storage.NotFoundError('No file');
    });

    await request(app)
      .get('/files/trade/20250101')
      .expect(404);
  });

  it('streams rows with ndjson content type', async () => {
    vi.mocked(storage.streamRows).mockReturnValue(
      Readable.from([Buffer.from('{"symbol":"XBTUSD"}\n')]) as never,
    );

    await request(app)
      .get('/files/trade/20250101')
      .expect(200)
      .expect('Content-Type', /ndjson/);
  });
});

// ── GET /files/:table/:date/headers ──────────────────────────────────────────

describe('GET /files/:table/:date/headers', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
    vi.mocked(storage.readHeaders).mockResolvedValue(['timestamp', 'symbol', 'price']);
  });

  it('returns 200 with the column array', async () => {
    const res = await request(app)
      .get('/files/trade/20250101/headers')
      .expect(200);

    expect(res.body).toEqual({ columns: ['timestamp', 'symbol', 'price'] });
    expect(storage.readHeaders).toHaveBeenCalledWith('trade', '20250101');
  });

  it('returns 404 when no file exists for that date', async () => {
    vi.mocked(storage.readHeaders).mockRejectedValue(new storage.NotFoundError('No file'));

    await request(app)
      .get('/files/trade/20250101/headers')
      .expect(404);
  });
});

// ── GET /tables ───────────────────────────────────────────────────────────────

describe('GET /tables', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  it('returns the array of table names', async () => {
    vi.mocked(storage.listTables).mockReturnValue(['trade', 'quote', 'instrument']);

    const res = await request(app)
      .get('/tables')
      .expect(200);

    expect(res.body).toEqual(['trade', 'quote', 'instrument']);
  });

  it('returns an empty array when no tables exist', async () => {
    vi.mocked(storage.listTables).mockReturnValue([]);

    const res = await request(app)
      .get('/tables')
      .expect(200);

    expect(res.body).toEqual([]);
  });
});

// ── GET /files/:table ─────────────────────────────────────────────────────────

describe('GET /files/:table', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  it('returns a map of dates to open/closed state', async () => {
    vi.mocked(storage.listFiles).mockReturnValue({
      '20250101': 'closed',
      '20250102': 'open',
    });

    const res = await request(app)
      .get('/files/trade')
      .expect(200);

    expect(res.body).toEqual({ '20250101': 'closed', '20250102': 'open' });
  });

  it('returns an empty object when no files exist', async () => {
    vi.mocked(storage.listFiles).mockReturnValue({});

    const res = await request(app)
      .get('/files/trade')
      .expect(200);

    expect(res.body).toEqual({});
  });
});
