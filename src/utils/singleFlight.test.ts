import { AsyncMutex, singleFlight } from './singleFlight';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('AsyncMutex', () => {
  it('runs tasks one at a time in FIFO order', async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];

    const task = (name: string, ms: number) =>
      mutex.runExclusive(async () => {
        order.push(`${name}:start`);
        await delay(ms);
        order.push(`${name}:end`);
        return name;
      });

    const results = await Promise.all([task('a', 30), task('b', 10), task('c', 5)]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('exposes isLocked while a task is executing or queued, and clears when idle', async () => {
    const mutex = new AsyncMutex();
    expect(mutex.isLocked).toBe(false);

    let releaseFirst!: () => void;
    const first = mutex.runExclusive(
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
    );

    // pendingCount is incremented synchronously before the first await,
    // so isLocked flips true as soon as runExclusive is invoked.
    expect(mutex.isLocked).toBe(true);

    const second = mutex.runExclusive(async () => {
      await delay(1);
    });

    expect(mutex.isLocked).toBe(true);

    // Let the microtask queue advance so `fn` for the first task actually
    // runs and populates `releaseFirst`.
    await Promise.resolve();
    await Promise.resolve();

    releaseFirst();
    await first;
    expect(mutex.isLocked).toBe(true); // second is still queued/running

    await second;
    expect(mutex.isLocked).toBe(false);
  });

  it('propagates a thrown error to its caller without poisoning the queue', async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];

    const failing = mutex.runExclusive(async () => {
      order.push('failing');
      throw new Error('boom');
    });

    const succeeding = mutex.runExclusive(async () => {
      order.push('succeeding');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(succeeding).resolves.toBe('ok');
    expect(order).toEqual(['failing', 'succeeding']);
  });

  it('keeps running queued tasks after multiple consecutive failures', async () => {
    const mutex = new AsyncMutex();
    const completed: string[] = [];

    const p1 = mutex.runExclusive(async () => {
      throw new Error('err1');
    });
    const p2 = mutex.runExclusive(async () => {
      throw new Error('err2');
    });
    const p3 = mutex.runExclusive(async () => {
      completed.push('p3');
      return 'p3-result';
    });

    await expect(p1).rejects.toThrow('err1');
    await expect(p2).rejects.toThrow('err2');
    await expect(p3).resolves.toBe('p3-result');
    expect(completed).toEqual(['p3']);
    expect(mutex.isLocked).toBe(false);
  });
});

describe('singleFlight', () => {
  it('coalesces N concurrent calls into a single underlying invocation', async () => {
    let callCount = 0;
    let releaseFn!: (value: string) => void;
    const fn = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          callCount++;
          releaseFn = resolve;
        })
    );

    const wrapped = singleFlight(fn);

    const p1 = wrapped();
    const p2 = wrapped();
    const p3 = wrapped();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    releaseFn('result');

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(['result', 'result', 'result']);
    expect(callCount).toBe(1);
  });

  it('starts a fresh invocation for a call made after the previous one settles', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      n++;
      return n;
    });

    const wrapped = singleFlight(fn);

    const first = await wrapped();
    const second = await wrapped();
    const third = await wrapped();

    expect([first, second, third]).toEqual([1, 2, 3]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('propagates a rejection to every coalesced caller and resets for the next call', async () => {
    let callCount = 0;
    let rejectFn!: (err: Error) => void;
    const fn = jest.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          callCount++;
          rejectFn = reject;
        })
    );

    const wrapped = singleFlight(fn);

    const p1 = wrapped();
    const p2 = wrapped();

    expect(fn).toHaveBeenCalledTimes(1);

    rejectFn(new Error('failure'));

    await expect(p1).rejects.toThrow('failure');
    await expect(p2).rejects.toThrow('failure');
    expect(callCount).toBe(1);

    // A call made after the rejection settles should trigger a fresh run.
    fn.mockImplementationOnce(async () => 'recovered');
    const p3 = await wrapped();
    expect(p3).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('runs a fresh invocation per call when calls are made sequentially (not overlapping)', async () => {
    let count = 0;
    const fn = jest.fn(async () => {
      count++;
      await delay(5);
      return count;
    });
    const wrapped = singleFlight(fn);

    const a = await wrapped();
    const b = await wrapped();
    const c = await wrapped();

    expect([a, b, c]).toEqual([1, 2, 3]);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
