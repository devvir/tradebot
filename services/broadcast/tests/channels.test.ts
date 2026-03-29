import { describe, it, expect } from 'vitest';
import {
  CHANNEL_PRESETS,
  channelPreset,
  type RealtimeChannelPreset,
} from '@tradebot/utils';

describe('channel presets', () => {
  it('feed contains every realtime channel', () => {
    const feed     = [...channelPreset('feed')];
    const realtime = [...channelPreset('primary'), ...channelPreset('secondary'), ...channelPreset('redundant')];

    expect(feed).toHaveLength(realtime.length);

    for (const ch of realtime) {
      expect(feed).toContain(ch);
    }
  });

  it('no preset contains duplicate channels', () => {
    for (const name of Object.keys(CHANNEL_PRESETS) as RealtimeChannelPreset[]) {
      const channels = channelPreset(name);
      const unique   = new Set(channels);

      expect(unique.size, `preset "${name}" has duplicate channels`).toBe(channels.length);
    }
  });

  it('platform channels do not appear in the realtime channel set', () => {
    const realtimeSet = new Set(channelPreset('feed'));

    for (const ch of channelPreset('platform')) {
      expect(realtimeSet.has(ch), `"${ch}" must not overlap with realtime channels`).toBe(false);
    }
  });
});
