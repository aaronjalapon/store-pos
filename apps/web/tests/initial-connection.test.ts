import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForInitialConnection } from '../lib/initial-connection';

describe('initial connection to a sleeping demo server', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries transient failures and HTML wake-up pages until the read succeeds', async () => {
    const read = vi.fn().mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockRejectedValueOnce(new SyntaxError('HTML loading page'))
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue({ needsSetup: false });
    const result = waitForInitialConnection(read, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await result).toEqual({ needsSetup: false });
    expect(read).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry client errors', async () => {
    const error = { status: 403 };
    const read = vi.fn().mockRejectedValue(error);
    await expect(waitForInitialConnection(read, new AbortController().signal)).rejects.toEqual(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a hanging request at the two-minute deadline', async () => {
    let requestSignal: AbortSignal | undefined;
    const read = vi.fn((signal: AbortSignal) => new Promise((_, reject) => {
      requestSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const check = expect(waitForInitialConnection(read, new AbortController().signal)).rejects.toThrow('Please try again');
    await vi.advanceTimersByTimeAsync(120_000);
    await check;
    expect(requestSignal?.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retry delays on unmount and never issues another request', async () => {
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(new TypeError('offline'));
    const check = expect(waitForInitialConnection(read, controller.signal)).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await check;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
