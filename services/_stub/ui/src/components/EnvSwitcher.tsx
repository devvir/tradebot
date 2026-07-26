/**
 * Dropdown that switches the active data environment. Persists across reloads
 * via `EnvProvider` (which uses the storage helper). The Replay option is
 * disabled at build time when `UI_REPLAY_HOST` is unset on the dev server.
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
