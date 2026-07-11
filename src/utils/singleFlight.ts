/**
 * A FIFO mutex for serializing async work.
 *
 * Calls to `runExclusive` are queued and run one at a time, in the order
 * they were made. Unlike a naive `promise.then(...)` chain, a throwing
 * task does not poison the queue: subsequent queued tasks still run even
 * if an earlier one rejects.
 *
 * @example
 * ```typescript
 * const mutex = new AsyncMutex();
 * const result = await mutex.runExclusive(async () => {
 *   return await doSomethingThatMustNotOverlap();
 * });
 * ```
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private pendingCount = 0;

  /**
   * True while a task is executing or waiting in the queue.
   */
  get isLocked(): boolean {
    return this.pendingCount > 0;
  }

  /**
   * Runs `fn` exclusively, after all previously queued tasks have finished
   * (successfully or not). Returns (or rejects with) whatever `fn` returns
   * or throws.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingCount++;

    // Capture the current tail, then immediately replace it with a new
    // promise for this call. This happens synchronously (no await in
    // between), so concurrent callers are chained in call order.
    const previous = this.tail;
    let releaseTail: () => void;
    this.tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });

    // `previous` never rejects (its own runner always resolves it in a
    // `finally`), so waiting on it cannot poison this call.
    await previous;

    try {
      return await fn();
    } finally {
      this.pendingCount--;
      releaseTail!();
    }
  }
}

/**
 * Wraps an async function so that concurrent calls while one invocation is
 * "in flight" are coalesced onto that same invocation's promise, instead of
 * each triggering a new call to `fn`.
 *
 * Once the in-flight call settles (resolves or rejects), the next call
 * starts a brand new invocation. A rejection is delivered to every caller
 * that was coalesced onto it.
 *
 * @example
 * ```typescript
 * const refresh = singleFlight(() => client.devices.list());
 * // Both calls below share a single underlying `client.devices.list()` call
 * // if they happen while the first is still pending.
 * const [a, b] = await Promise.all([refresh(), refresh()]);
 * ```
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return function invoke(): Promise<T> {
    if (inFlight) {
      return inFlight;
    }

    const promise = fn().finally(() => {
      // Only clear the slot if we're still the current in-flight run.
      if (inFlight === promise) {
        inFlight = null;
      }
    });

    inFlight = promise;
    return promise;
  };
}
