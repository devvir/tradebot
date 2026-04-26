/**
 * HTTP client for digger's control-plane API.
 *
 * Digger is the replay engine — it serves historical BitMEX data from MongoDB
 * at a configurable replay clock. This client lets the UI act as an orchestrator:
 * setting the clock moves the entire replay stream to a new point in time.
 */
export class DiggerClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * Move the replay clock to `timestamp` (epoch ms).
   * Digger pauses, purges downstream queues, resets its snapshot accumulator,
   * re-primes all active subscriptions at the new position, then resumes.
   * Returns when the operation is complete and fresh data is about to flow.
   */
  async setClock(timestamp: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/set-clock?timestamp=${timestamp}`, {
      method: 'POST',
    });

    if (! res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`set-clock failed (${res.status})${text ? `: ${text}` : ''}`);
    }
  }
}
