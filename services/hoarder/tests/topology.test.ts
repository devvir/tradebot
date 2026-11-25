import { describe, it, expect } from 'vitest';
import { topologyFor } from '../src/topology';

describe('topology', () => {
  const topology = topologyFor({ name: 'frames', maxLength: 500 });
  const exchange = topology.exchanges!['hoarder']!;

  it('declares the topic exchange frames are published to', () => {
    expect(Object.keys(topology.exchanges!)).toEqual(['hoarder']);
    expect(exchange.type).toBe('topic');
  });

  // Bound for every routing key, so frames of every venue wait for a consumer
  // that is not attached, instead of being discarded.
  it('binds one durable queue to the exchange for every venue', () => {
    expect(Object.keys(exchange.queues!)).toEqual(['frames']);
    expect(exchange.queues!['frames']).toMatchObject({ durable: true, routingKey: '#' });
  });

  // Capped, dropping the oldest frames once full, so a queue nobody drains
  // cannot fill the broker's disk.
  it('caps the queue at the configured length, dropping the oldest frames', () => {
    expect(exchange.queues!['frames']!.arguments).toEqual({ 'x-max-length': 500, 'x-overflow': 'drop-head' });
  });
});
