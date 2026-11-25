/**
 * Dropdown that shows and sets the active data environment through `useEnv()`.
 * The Replay option is disabled when the build has replay off
 * (`__REPLAY_ENABLED__`, which vite.config.ts sets from `UI_DIGGER_HOST`).
 */

import { useEnv } from '../data/EnvProvider';
import type { Env } from '../types';

declare const __REPLAY_ENABLED__: boolean;

const ENV_LABELS: Record<Env, string> = {
  live:    'Live',
  testnet: 'Testnet',
  replay:  'Replay',
};

export function EnvSwitcher() {
  const { env, setEnv } = useEnv();

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16 }}>
      <span style={{ fontSize: 11, color: 'var(--OnBackground-Medium-Emphasis)' }}>Env</span>
      <select
        aria-label="Data environment"
        value={env}
        onChange={(e) => setEnv(e.target.value as Env)}
        style={{
          background:   'var(--Gray-Gray-80)',
          border:       '1px solid var(--Border-Border-Default)',
          borderRadius: 4,
          color:        'var(--OnBackground-High-Emphasis)',
          fontSize:     11,
          padding:      '2px 6px',
          cursor:       'pointer',
        }}
      >
        <option value="live">{ENV_LABELS.live}</option>
        <option value="testnet">{ENV_LABELS.testnet}</option>
        <option value="replay" disabled={! __REPLAY_ENABLED__}>{ENV_LABELS.replay}</option>
      </select>
    </div>
  );
}
