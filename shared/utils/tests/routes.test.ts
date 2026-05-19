import { describe, it, expect } from 'vitest';
import { parseRules } from '../src/routes';
import type { ParsedRule } from '../src/routes';

// ── Helpers ───────────────────────────────────────────────────────────────────

const one = (raw: string): ParsedRule => {
  const rules = parseRules(raw);
  expect(rules).toHaveLength(1);
  return rules[0]!;
};

// ── Item syntax: bare queue ───────────────────────────────────────────────────

describe('bare queue name', () => {
  it('parses single bare queue', () => {
    const r = one('broadcast > writer');
    expect(r.source).toEqual({ queue: 'broadcast' });
    expect(r.destination).toEqual({ queue: 'writer' });
  });

  it('parses queue names with dots', () => {
    const r = one('codec.broadcast > codec.writer');
    expect(r.source.queue).toBe('codec.broadcast');
    expect(r.destination.queue).toBe('codec.writer');
  });

  it('parses queue names with hyphens and underscores', () => {
    const r = one('my-queue > my_queue');
    expect(r.source.queue).toBe('my-queue');
    expect(r.destination.queue).toBe('my_queue');
  });
});

// ── Item syntax: @-prefixed exchange ─────────────────────────────────────────

describe('exchange via @-prefix', () => {
  it('parses @exchange (no type)', () => {
    const r = one('@events > @archive');
    expect(r.source).toEqual({ exchange: { name: 'events' } });
    expect(r.destination).toEqual({ exchange: { name: 'archive' } });
  });

  it('parses @fanout:name', () => {
    const r = one('@fanout:events > @fanout:archive');
    expect(r.source.exchange).toEqual({ name: 'events', type: 'fanout' });
    expect(r.destination.exchange).toEqual({ name: 'archive', type: 'fanout' });
  });

  it('parses @topic:name', () => {
    const r = one('broadcast > @topic:events');
    expect(r.destination.exchange).toEqual({ name: 'events', type: 'topic' });
  });

  it('parses @direct:name', () => {
    const r = one('@direct:orders > writer');
    expect(r.source.exchange).toEqual({ name: 'orders', type: 'direct' });
  });

  it('parses @headers:name', () => {
    const r = one('@headers:meta > writer');
    expect(r.source.exchange).toEqual({ name: 'meta', type: 'headers' });
  });

  it('parses @default:name', () => {
    const r = one('@default:events > writer');
    expect(r.source.exchange).toEqual({ name: 'events', type: 'default' });
  });
});

// ── Item syntax: type:name shorthand (pipe-style) ────────────────────────────

describe('type:name shorthand (no @)', () => {
  it('parses fanout:name', () => {
    const r = one('fanout:clerk > fanout:assembler');
    expect(r.source.exchange).toEqual({ name: 'clerk', type: 'fanout' });
    expect(r.destination.exchange).toEqual({ name: 'assembler', type: 'fanout' });
  });

  it('parses topic:name', () => {
    const r = one('topic:clerk > fanout:assembler');
    expect(r.source.exchange).toEqual({ name: 'clerk', type: 'topic' });
  });

  it('parses direct:name', () => {
    const r = one('direct:orders > fanout:notify');
    expect(r.source.exchange).toEqual({ name: 'orders', type: 'direct' });
  });

  it('parses headers:name', () => {
    const r = one('headers:meta > fanout:dst');
    expect(r.source.exchange).toEqual({ name: 'meta', type: 'headers' });
  });

  it('type:name and @type:name are equivalent', () => {
    const a = one('topic:clerk > fanout:assembler');
    const b = one('@topic:clerk > @fanout:assembler');
    expect(a.source.exchange).toEqual(b.source.exchange);
    expect(a.destination.exchange).toEqual(b.destination.exchange);
  });

  it('parses exchange names with dots', () => {
    const r = one('fanout:codec.out > fanout:writer.in');
    expect(r.source.exchange!.name).toBe('codec.out');
    expect(r.destination.exchange!.name).toBe('writer.in');
  });
});

// ── Item syntax: queue@exchange ───────────────────────────────────────────────

describe('queue bound to exchange (queue@[type:]exchange)', () => {
  it('parses queue@exchange (no type)', () => {
    const r = one('inbound@events > writer');
    expect(r.source).toEqual({ queue: 'inbound', exchange: { name: 'events' } });
  });

  it('parses queue@fanout:exchange', () => {
    const r = one('inbound@fanout:events > writer');
    expect(r.source).toEqual({ queue: 'inbound', exchange: { name: 'events', type: 'fanout' } });
  });

  it('parses queue@topic:exchange', () => {
    const r = one('listener@topic:broadcasts > sink');
    expect(r.source).toEqual({ queue: 'listener', exchange: { name: 'broadcasts', type: 'topic' } });
  });

  it('parses destination queue@exchange', () => {
    const r = one('src > writer@fanout:output');
    expect(r.destination).toEqual({ queue: 'writer', exchange: { name: 'output', type: 'fanout' } });
  });

  it('parses exchange-only destination via @', () => {
    const r = one('inbound@topic:events > @fanout:output');
    expect(r.destination).toEqual({ exchange: { name: 'output', type: 'fanout' } });
    expect(r.destination.queue).toBeUndefined();
  });
});

// ── Modifiers: routing key ────────────────────────────────────────────────────

describe('routing key modifier', () => {
  it('parses (key:value) on source', () => {
    const r = one('topic:clerk(key:fragment) > fanout:assembler');
    expect(r.source.routingKey).toEqual({ value: 'fragment' });
  });

  it('parses (key:value) on destination', () => {
    const r = one('src > @topic:output(key:message)');
    expect(r.destination.routingKey).toEqual({ value: 'message' });
  });

  it('parses (key:value:replace) — router-style replacement', () => {
    const r = one('src > @topic:output(key:message:collect)');
    expect(r.destination.routingKey).toEqual({ value: 'message', replace: 'collect' });
  });

  it('parses wildcard key #', () => {
    const r = one('topic:src(key:#) > fanout:dst');
    expect(r.source.routingKey).toEqual({ value: '#' });
  });

  it('parses wildcard key *', () => {
    const r = one('topic:src(key:trade.*) > fanout:dst');
    expect(r.source.routingKey).toEqual({ value: 'trade.*' });
  });

  it('parses multi-segment key', () => {
    const r = one('topic:src(key:a.b.c.d) > fanout:dst');
    expect(r.source.routingKey).toEqual({ value: 'a.b.c.d' });
  });

  it('no routingKey when modifier absent', () => {
    const r = one('fanout:src > fanout:dst');
    expect(r.source.routingKey).toBeUndefined();
    expect(r.destination.routingKey).toBeUndefined();
  });
});

// ── Modifiers: headers ────────────────────────────────────────────────────────

describe('header modifiers', () => {
  it('parses single header on destination', () => {
    const r = one('src > @topic:out(header:x-table=trade)');
    expect(r.destination.headers).toEqual({ 'x-table': 'trade' });
  });

  it('parses multiple headers', () => {
    const r = one('src > @topic:out(header:x-a=1,header:x-b=2)');
    expect(r.destination.headers).toEqual({ 'x-a': '1', 'x-b': '2' });
  });

  it('parses empty header value', () => {
    const r = one('src > @topic:out(header:x-flag=)');
    expect(r.destination.headers).toEqual({ 'x-flag': '' });
  });

  it('parses key and header combined', () => {
    const r = one('src > @topic:out(key:record,header:x-t=trade)');
    expect(r.destination.routingKey).toEqual({ value: 'record' });
    expect(r.destination.headers).toEqual({ 'x-t': 'trade' });
  });
});

// ── Multiple rules (| separator) ─────────────────────────────────────────────

describe('multiple rules', () => {
  it('parses two rules', () => {
    const rules = parseRules('broadcast > writer | reader > archive');
    expect(rules).toHaveLength(2);
    expect(rules[0]!.source.queue).toBe('broadcast');
    expect(rules[1]!.source.queue).toBe('reader');
  });

  it('parses three rules', () => {
    const rules = parseRules('a > b | b > c | c > d');
    expect(rules).toHaveLength(3);
  });

  it('accepts leading | separator', () => {
    const rules = parseRules('| broadcast > writer | reader > archive');
    expect(rules).toHaveLength(2);
  });

  it('strips whitespace around all operators', () => {
    const rules = parseRules('  broadcast  >  writer  |  reader  >  archive  ');
    expect(rules).toHaveLength(2);
    expect(rules[0]!.source.queue).toBe('broadcast');
  });

  it('handles multi-line YAML literal block format', () => {
    const rules = parseRules(`
      | inbound@topic:events > writer
      | reader > archive
    `);
    expect(rules).toHaveLength(2);
    expect(rules[0]!.source.queue).toBe('inbound');
    expect(rules[1]!.source.queue).toBe('reader');
  });
});

// ── Fan-out: multiple sources & destinations ──────────────────────────────────

describe('& fan-out expansion', () => {
  it('expands one source × multiple destinations', () => {
    const rules = parseRules('broadcast > writer & archive & replay');
    expect(rules).toHaveLength(3);
    expect(rules.every(r => r.source.queue === 'broadcast')).toBe(true);
    expect(rules.map(r => r.destination.queue)).toEqual(['writer', 'archive', 'replay']);
  });

  it('expands multiple sources × one destination', () => {
    const rules = parseRules('broadcast & reader > writer');
    expect(rules).toHaveLength(2);
    expect(rules.map(r => r.source.queue)).toEqual(['broadcast', 'reader']);
    expect(rules.every(r => r.destination.queue === 'writer')).toBe(true);
  });

  it('cross-products multiple sources × multiple destinations', () => {
    const rules = parseRules('a & b > x & y');
    expect(rules).toHaveLength(4);
    expect(rules.map(r => `${r.source.queue}>${r.destination.queue}`)).toEqual([
      'a>x', 'a>y', 'b>x', 'b>y',
    ]);
  });

  it('cross-products with exchanges', () => {
    const rules = parseRules('in@topic:events & reader > w@fanout:writer & audit@topic:audit & replay');
    // 2 sources × 3 destinations = 6 rules: in×w, in×audit, in×replay, reader×w, reader×audit, reader×replay
    expect(rules).toHaveLength(6);
    expect(rules[0]!.source).toEqual({ queue: 'in', exchange: { name: 'events', type: 'topic' } });
    expect(rules[1]!.destination.exchange).toEqual({ name: 'audit', type: 'topic' });
  });
});

// ── Real-world pipe syntax ────────────────────────────────────────────────────

describe('multi-stage pipe syntax', () => {
  it('parses topic→fanout binding with key filter', () => {
    const rules = parseRules('| fragment@topic:source(key:fragment) > fanout:stage-a');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toEqual({
      queue:      'fragment',
      exchange:   { name: 'source', type: 'topic' },
      routingKey: { value: 'fragment' },
    });
    expect(rules[0]!.destination).toEqual({ exchange: { name: 'stage-a', type: 'fanout' } });
  });

  it('parses topic→fanout binding with different key filter', () => {
    const rules = parseRules('| record@topic:source(key:record) > fanout:stage-b');
    expect(rules[0]!.source).toEqual({
      queue:      'record',
      exchange:   { name: 'source', type: 'topic' },
      routingKey: { value: 'record' },
    });
  });

  it('parses topic→fanout binding with no key', () => {
    const rules = parseRules('| topic:stage-a > fanout:stage-b');
    expect(rules[0]!.source).toEqual({ exchange: { name: 'stage-a', type: 'topic' } });
    expect(rules[0]!.destination).toEqual({ exchange: { name: 'stage-b', type: 'fanout' } });
  });

  it('parses three rules together', () => {
    const rules = parseRules(`
      | fragment@topic:source(key:fragment) > fanout:stage-a
      | record@topic:source(key:record)     > fanout:stage-b
      | topic:stage-a                       > fanout:stage-b
    `);
    expect(rules).toHaveLength(3);
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe('error cases', () => {
  it('throws when rule is missing >', () => {
    expect(() => parseRules('broadcast writer')).toThrow("Rule missing '>'");
  });

  it('throws when rule has multiple >', () => {
    expect(() => parseRules('a > b > c')).toThrow("exactly one '>'");
  });

  it('throws for empty source', () => {
    expect(() => parseRules(' > writer')).toThrow('No sources');
  });

  it('throws for empty destination', () => {
    expect(() => parseRules('broadcast > ')).toThrow('No destinations');
  });

  it('throws for invalid exchange type', () => {
    expect(() => parseRules('broadcast > writer@invalid:exchange')).toThrow('Invalid exchange type "invalid"');
  });

  it('includes valid types in error message', () => {
    expect(() => parseRules('bad:src > fanout:dst')).toThrow(
      'Valid types: fanout, topic, direct, headers, default',
    );
  });

  it('throws for invalid route item (empty brackets)', () => {
    expect(() => parseRules('!!! > fanout:dst')).toThrow();
  });

  it('throws for unclosed parenthesis', () => {
    expect(() => parseRules('topic:src(key:foo > fanout:dst')).toThrow('Unclosed parenthesis');
  });

  it('throws for unknown modifier', () => {
    expect(() => parseRules('src > dst(unknown:val)')).toThrow('Unknown modifier');
  });

  it('throws for header modifier missing = separator', () => {
    expect(() => parseRules('src > dst(header:name-without-equals)')).toThrow('"=" separator');
  });

  it('throws for empty header name', () => {
    expect(() => parseRules('src > dst(header:=value)')).toThrow('header name cannot be empty');
  });

  it('throws for invalid queue name in queue@exchange', () => {
    expect(() => parseRules('!!q@fanout:ex > dst')).toThrow();
  });
});
