import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { closeServer } from '../../src/server';

const listen = (handler: http.RequestListener): Promise<http.Server> => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const portOf = (server: http.Server): number => (server.address() as AddressInfo).port;

describe('closeServer', () => {
  it('waits for an in-flight request to finish', async () => {
    let respond!: () => void;

    const server = await listen((_req, res) => { respond = () => res.end('done'); });
    const agent  = new http.Agent({ keepAlive: true });

    const body = new Promise<string>((resolve, reject) => {
      http.get({ port: portOf(server), host: '127.0.0.1', agent }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => { text += c.toString(); });
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });

    await new Promise(r => setTimeout(r, 20));

    let closed = false;
    const closing = closeServer(server, 5_000).then(() => { closed = true; });

    await new Promise(r => setTimeout(r, 20));
    expect(closed).toBe(false);

    respond();

    expect(await body).toBe('done');
    await closing;
    expect(server.listening).toBe(false);
    agent.destroy();
  });

  it('cuts a request that outlives the deadline', async () => {
    const server = await listen(() => { /* never responds */ });

    const failed = new Promise<boolean>((resolve) => {
      http.get({ port: portOf(server), host: '127.0.0.1' }, () => resolve(false)).on('error', () => resolve(true));
    });

    await new Promise(r => setTimeout(r, 20));

    const started = Date.now();
    await closeServer(server, 100);

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await failed).toBe(true);
  });

  it('resolves when the server is not listening', async () => {
    const server = http.createServer();

    await expect(closeServer(server, 100)).resolves.toBeUndefined();
  });
});
