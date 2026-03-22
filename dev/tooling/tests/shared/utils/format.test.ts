import { describe, it, expect } from 'vitest';
import { fmtBytes, fmtUptime, fmtAgo } from '../../../src/shared/utils/format';

describe('fmtBytes', () => {
  it('formats bytes to human-readable', () => {
    expect(fmtBytes(0)).toBe('0B');
    expect(fmtBytes(512)).toBe('512.0B');
    expect(fmtBytes(1024)).toBe('1.0KB');
    expect(fmtBytes(1024 * 1024)).toBe('1.0MB');
    expect(fmtBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5GB');
  });
});

describe('fmtUptime', () => {
  it('formats seconds into human-readable uptime', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(fmtUptime(now - 30)).toBe('30s');
    expect(fmtUptime(now - 90)).toBe('1m 30s');
    expect(fmtUptime(now - 3661)).toBe('1h 1m');
    expect(fmtUptime(now - 86400 * 2)).toBe('2d 0h');
  });

  it('returns — for future timestamps', () => {
    expect(fmtUptime(Math.floor(Date.now() / 1000) + 100)).toBe('—');
  });
});

describe('fmtAgo', () => {
  it('formats ISO timestamp to time-ago string', () => {
    const now = new Date();
    expect(fmtAgo(new Date(now.getTime() - 2000).toISOString())).toBe('just now');
    expect(fmtAgo(new Date(now.getTime() - 30000).toISOString())).toBe('30s ago');
    expect(fmtAgo(new Date(now.getTime() - 5 * 60000).toISOString())).toBe('5m ago');
    expect(fmtAgo(new Date(now.getTime() - 2 * 3600000).toISOString())).toBe('2h ago');
    expect(fmtAgo('not-a-date')).toBe('N/A');
  });

  it('handles nanosecond-precision Docker timestamps', () => {
    const now = new Date();
    const base = new Date(now.getTime() - 30000).toISOString().replace('Z', '');
    const nano = `${base}012345Z`;
    expect(fmtAgo(nano)).toBe('30s ago');
  });
});
