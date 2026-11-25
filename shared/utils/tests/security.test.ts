import { beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => [] as unknown[][]);

vi.mock('@devvir/service-kit', () => {
  const record = (...args: unknown[]) => { logged.push(args); };
  return { logger: { debug: record, info: record, warn: record, error: record } };
});

import { redactUrl } from '../src/security';

const urlWith = (password: string, username = 'user') => `amqp://${username}:${password}@rabbitmq:5672/vhost`;

const PASSWORDS = ['p#ss', 'p/ss', '123/abc', 'p?ss', 'p%ss', '100%', 'p%41ss', 'p%40ss', 'p@ss', 'p@s#s', 'p:ss'];

const expectNotLogged = (secret: string) => {
  for (const args of logged) expect(JSON.stringify(args)).not.toContain(secret);
};

beforeEach(() => { logged.length = 0; });

describe('redactUrl', () => {
  it.each(PASSWORDS)('never returns nor logs any part of the password %j', (password) => {
    const out = redactUrl(urlWith(password));

    expect(out).not.toContain(password);
    expect(out).not.toContain(password.slice(1));
    expectNotLogged(password);
  });

  it('never returns nor logs a username that holds a colon', () => {
    const out = redactUrl(urlWith('secret', 'us:er'));

    expect(out).not.toContain('us:er');
    expect(out).not.toContain('secret');
    expectNotLogged('secret');
  });

  it('keeps the scheme, host, port and vhost of a URL', () => {
    expect(redactUrl('amqp://user:pass@rabbitmq:5672/vhost')).toBe('amqp://*****:*****@rabbitmq:5672/vhost');
    expect(redactUrl(urlWith('p#ss'))).toBe('amqp://*****:*****@rabbitmq:5672/vhost');
  });

  it('leaves a URL without credentials unchanged', () => {
    expect(redactUrl('amqp://rabbitmq:5672/vhost')).toBe('amqp://rabbitmq:5672/vhost');
    expect(logged).toEqual([]);
  });

  it('redacts in full, logging only why, when the host does not parse', () => {
    expect(redactUrl('amqp://user:secret@bad host:5672')).toBe('*****');
    expect(redactUrl('user:secret@')).not.toContain('secret');
    expect(redactUrl('//user:secret@rabbitmq')).toBe('*****');

    expect(logged.length).toBeGreaterThan(0);
    expectNotLogged('secret');
  });
});
