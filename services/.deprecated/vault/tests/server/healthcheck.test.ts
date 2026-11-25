import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import { recordFailure, _test_reset } from '../../src/fs/health';
import { answerHealthCheck } from '../../src/server/healthcheck';

const server = http.createServer((_req, res) => answerHealthCheck(res));

beforeEach(() => _test_reset());
afterEach(() => _test_reset());

describe('answerHealthCheck', () => {
  it('answers 200 while storage is healthy', async () => {
    const res = await request(server).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('answers 503 with the reason while storage is unhealthy', async () => {
    for (let i = 0; i < 5; i++) recordFailure('disk full');

    const res = await request(server).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
    expect(res.body.reason).toMatch(/disk full/);
  });
});
