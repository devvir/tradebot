/**
 * Bounded async queue with separate producer/consumer suspension. Designed
 * for exactly one producer and one consumer — the single-waiter pattern is
 * sufficient and avoids array bookkeeping.
 */
export class BoundedQueue<T> {
  private readonly items:    T[]   = [];
  private          size:     number = 0;
  private          closed:   boolean = false;
  private          error:    Error | null = null;
  private          wakePush: (() => void) | null = null;
  private          wakeTake: (() => void) | null = null;

  constructor(
    private readonly capacity: number,
    private readonly sizeOf:   (item: T) => number = () => 1,
  ) {}

  async push(item: T): Promise<void> {
    while (this.size >= this.capacity && ! this.closed) {
      await new Promise<void>(r => { this.wakePush = r; });
    }

    if (this.closed) return; // dropped — caller decides whether to error

    this.items.push(item);
    this.size += this.sizeOf(item);

    const r = this.wakeTake;

    if (r) {
      this.wakeTake = null;
      r();
    }
  }

  async take(): Promise<T | null> {
    while (this.items.length === 0) {
      if (this.error)  throw this.error;
      if (this.closed) return null;

      await new Promise<void>(r => { this.wakeTake = r; });
    }

    const item = this.items.shift()!;

    this.size -= this.sizeOf(item);

    const r = this.wakePush;

    if (r) {
      this.wakePush = null;
      r();
    }

    return item;
  }

  close(): void {
    this.closed = true;

    const t = this.wakeTake;
    if (t) { this.wakeTake = null; t(); }

    const p = this.wakePush;
    if (p) { this.wakePush = null; p(); }
  }

  fail(err: Error): void {
    this.error = err;
    this.close();
  }
}
