import { afterEach, describe, expect, it, vi } from 'vitest';
import { send } from '../web/api';

/** `send`, against answers stood in for `fetch`. */

const answering = (body: string, status: number): void => {
  vi.stubGlobal('fetch', async () => new Response(body, { status }));
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('send', () => {
  it('hands back a JSON body with its status', async () => {
    answering('{"problems":[{"at":"x"}]}', 400);

    expect(await send('/api/catalog/lenses', 'POST', {})).toEqual({ status: 400, body: { problems: [{ at: 'x' }] } });
  });

  it('hands back an empty body as {}', async () => {
    answering('', 200);

    expect(await send('/api/catalog/lenses/x', 'PUT', {})).toEqual({ status: 200, body: {} });
  });

  it('hands back a body that is not JSON as its error, without throwing', async () => {
    const html = `<!DOCTYPE html><pre>Cannot PUT /lenses/x</pre>${'.'.repeat(400)}`;

    answering(html, 404);

    const { status, body } = await send<{ error: string }>('/api/catalog/lenses/x', 'PUT', {});

    expect(status).toBe(404);
    expect(body.error).toBe(html.slice(0, 300));
  });
});
