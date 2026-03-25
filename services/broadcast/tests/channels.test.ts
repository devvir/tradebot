import { describe, it, expect } from 'vitest';
import {
  REALTIME_PRIMARY_CHANNELS,
  REALTIME_SECONDARY_CHANNELS,
  REALTIME_CHANNELS,
  REALTIME_CHANNEL_PRESETS,
  PLATFORM_CHANNELS,
} from '../src/channels';

describe('channel presets', () => {
  it('archive contains exactly primary and secondary channels', () => {
    const expected = [...REALTIME_PRIMARY_CHANNELS, ...REALTIME_SECONDARY_CHANNELS];
    const archive  = [...REALTIME_CHANNEL_PRESETS.archive];

    expect(archive).toHaveLength(expected.length);

    for (const ch of expected) {
      expect(archive).toContain(ch);
    }
  });

  it('feed contains every realtime channel', () => {
    const feed = [...REALTIME_CHANNEL_PRESETS.feed];

    expect(feed).toHaveLength(REALTIME_CHANNELS.length);

    for (const ch of REALTIME_CHANNELS) {
      expect(feed).toContain(ch);
    }
  });

  it('no preset contains duplicate channels', () => {
    for (const [name, channels] of Object.entries(REALTIME_CHANNEL_PRESETS)) {
      const unique = new Set(channels);

      expect(unique.size, `preset "${name}" has duplicate channels`).toBe(channels.length);
    }
  });

  it('platform channels do not appear in the realtime channel set', () => {
    const realtimeSet = new Set(REALTIME_CHANNELS);

    for (const ch of PLATFORM_CHANNELS) {
      expect(realtimeSet.has(ch), `"${ch}" must not overlap with realtime channels`).toBe(false);
    }
  });
});
