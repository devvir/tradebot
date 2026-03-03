import { describe, it, expect } from 'vitest';
import parseBindings from '../src/bindings';

// ── parseBindings ─────────────────────────────────────────────────────────────

describe('parseBindings', () => {

  describe('Exchange types', () => {
    it('parses fanout:name > fanout:name', () => {
      const [b] = parseBindings('fanout:src > fanout:dst');
      expect(b.source).toEqual({ name: 'src', type: 'fanout' });
      expect(b.destination).toEqual({ name: 'dst', type: 'fanout' });
    });

    it('parses topic source', () => {
      const [b] = parseBindings('topic:events > fanout:archive');
      expect(b.source).toEqual({ name: 'events', type: 'topic' });
    });

    it('parses direct source with key', () => {
      const [b] = parseBindings('direct:orders(key:new) > fanout:notify');
      expect(b.source).toEqual({ name: 'orders', type: 'direct' });
      expect(b.routingKey).toBe('new');
    });

    it('parses headers source', () => {
      const [b] = parseBindings('headers:src > fanout:dst');
      expect(b.source).toEqual({ name: 'src', type: 'headers' });
    });

    it('parses exchange with no type', () => {
      const [b] = parseBindings('src > dst');
      expect(b.source).toEqual({ name: 'src' });
      expect(b.destination).toEqual({ name: 'dst' });
    });

    it('parses mixed types on source and destination', () => {
      const [b] = parseBindings('topic:events > direct:router');
      expect(b.source.type).toBe('topic');
      expect(b.destination.type).toBe('direct');
    });
  });

  describe('Exchange names', () => {
    it('parses names with dots', () => {
      const [b] = parseBindings('fanout:codec.out > fanout:writer.in');
      expect(b.source.name).toBe('codec.out');
      expect(b.destination.name).toBe('writer.in');
    });

    it('parses names with hyphens', () => {
      const [b] = parseBindings('fanout:my-exchange > fanout:other-exchange');
      expect(b.source.name).toBe('my-exchange');
    });

    it('parses names with underscores', () => {
      const [b] = parseBindings('fanout:my_exchange > fanout:other');
      expect(b.source.name).toBe('my_exchange');
    });
  });

  describe('Routing keys', () => {
    it('returns no routingKey when not specified', () => {
      const [b] = parseBindings('fanout:src > fanout:dst');
      expect(b.routingKey).toBeUndefined();
    });

    it('parses simple routing key', () => {
      const [b] = parseBindings('topic:src(key:trade.btc) > fanout:dst');
      expect(b.routingKey).toBe('trade.btc');
    });

    it('parses wildcard routing key #', () => {
      const [b] = parseBindings('topic:src(key:#) > fanout:dst');
      expect(b.routingKey).toBe('#');
    });

    it('parses wildcard routing key *', () => {
      const [b] = parseBindings('topic:src(key:trade.*) > fanout:dst');
      expect(b.routingKey).toBe('trade.*');
    });

    it('parses multi-segment routing key', () => {
      const [b] = parseBindings('topic:src(key:a.b.c.d) > fanout:dst');
      expect(b.routingKey).toBe('a.b.c.d');
    });
  });

  describe('Multiple bindings', () => {
    it('parses two bindings separated by |', () => {
      const bindings = parseBindings('fanout:a > fanout:b | fanout:c > fanout:d');
      expect(bindings).toHaveLength(2);
      expect(bindings[0].source.name).toBe('a');
      expect(bindings[1].source.name).toBe('c');
    });

    it('parses three bindings', () => {
      const bindings = parseBindings('fanout:a > fanout:b | fanout:b > fanout:c | fanout:c > fanout:d');
      expect(bindings).toHaveLength(3);
    });

    it('strips whitespace around separators', () => {
      const bindings = parseBindings(' fanout:a > fanout:b | fanout:c > fanout:d ');
      expect(bindings).toHaveLength(2);
      expect(bindings[0].source.name).toBe('a');
    });

    it('handles leading | separator', () => {
      const bindings = parseBindings('| fanout:a > fanout:b | fanout:c > fanout:d');
      expect(bindings).toHaveLength(2);
    });
  });

  describe('No defaults applied', () => {
    it('does not add a default routingKey for topic source', () => {
      // Defaults are config.ts's responsibility, not bindings.ts
      const [b] = parseBindings('topic:src > fanout:dst');
      expect(b.routingKey).toBeUndefined();
    });

    it('does not throw for direct source without routingKey', () => {
      // Business rule validation is config.ts's responsibility
      expect(() => parseBindings('direct:src > fanout:dst')).not.toThrow();
    });
  });

  describe('Error cases', () => {
    it('throws when binding is missing >', () => {
      expect(() => parseBindings('fanout:src fanout:dst')).toThrow("Binding missing '>'");
    });

    it('throws when binding has multiple >', () => {
      expect(() => parseBindings('fanout:a > fanout:b > fanout:c')).toThrow("exactly one '>'");
    });

    it('throws when routing key is on the destination side', () => {
      expect(() => parseBindings('fanout:src > topic:dst(key:trade.*)')).toThrow(
        'Routing key can only be set on the source side',
      );
    });

    it('throws for invalid exchange spec', () => {
      expect(() => parseBindings('!!! > fanout:dst')).toThrow('Invalid exchange spec');
    });

    it('throws for invalid exchange type', () => {
      expect(() => parseBindings('invalid:src > fanout:dst')).toThrow('Invalid exchange type "invalid"');
    });

    it('includes valid types in the error message', () => {
      expect(() => parseBindings('bad:src > fanout:dst')).toThrow(
        'Valid types: fanout, topic, direct, headers',
      );
    });
  });
});

