/**
 * HTTP client for a replay control endpoint at `baseUrl`. Its one operation
 * sets the replay clock: `POST <baseUrl>/set-clock?timestamp=<epoch ms>`.
 */
export class DiggerClient {
  constructor(private readonly baseUrl: string) {}

  /**
   * Move the replay clock to `timestamp` (epoch ms). Resolves when the endpoint
   * answers with a 2xx status; otherwise rejects with the status and the
   * response body.
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
