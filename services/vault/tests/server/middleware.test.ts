import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorMiddleware } from '../../src/server/middleware';

const app = express();

app.post('/json', express.json({ limit: '10b' }), (_req, res) => { res.status(204).end(); });
app.get('/throws', () => { throw new Error('boom'); });
app.get('/teapot', () => { throw Object.assign(new Error('hidden detail'), { status: 418 }); });

app.use(errorMiddleware);

describe('errorMiddleware', () => {
  it('answers 400 for malformed JSON', async () => {
    const res = await request(app).post('/json').set('Content-Type', 'application/json').send('{"a":');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON body' });
  });

  it('passes a 413 for a body over the size limit through', async () => {
    const res = await request(app).post('/json').send({ long: 'x'.repeat(100) });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
  });

  it('passes a 415 for an unsupported charset through', async () => {
    const res = await request(app)
      .post('/json')
      .set('Content-Type', 'application/json; charset=latin9')
      .send('{}');

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/charset/i);
  });

  it('answers 500 for an error from a handler', async () => {
    const res = await request(app).get('/throws');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('answers 500 for a 4xx error not meant to be shown', async () => {
    const res = await request(app).get('/teapot');

    expect(res.status).toBe(500);
  });
});
