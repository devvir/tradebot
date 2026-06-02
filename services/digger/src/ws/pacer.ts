import type { WsServerHandle } from '@devvir/service-kit';
import type { Config } from '../types';
import type { PacerMode } from './types';

/**
 * The slowest-client gate. Emission proceeds only while the maximum socket
 * `bufferedAmount` across all clients is under the high-water mark; once over it
 * stays gated until it drains below the low-water mark (hysteresis prevents
 * flapping). The slowest client thus paces the whole shared timeline, byte-fair,
 * with no per-message accounting.
 *
 * `mode` is the seam for the future speed/pause controls; `paused` simply never
 * emits.
 */
export class Pacer {
  mode: PacerMode = 'max';

  #gated = false;

  constructor(private readonly server: WsServerHandle, private readonly config: Config) {}

  mayEmit(): boolean {
    if (this.mode === 'paused') return false;

    const max = this.#maxBuffered();

    if (this.#gated) {
      if (max < this.config.bpLow) this.#gated = false;
    } else if (max > this.config.bpHigh) {
      this.#gated = true;
    }

    return ! this.#gated;
  }

  #maxBuffered(): number {
    let max = 0;

    for (const client of this.server.clients()) {
      const ba = client.socket.bufferedAmount;

      if (ba > max) max = ba;
    }

    return max;
  }
}
