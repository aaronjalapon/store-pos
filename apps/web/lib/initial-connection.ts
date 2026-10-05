// Only wrap the initial, read-only setup request. Mutations must never be retried here.
export async function waitForInitialConnection<T>(read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), 120_000);
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    while (!combined.aborted) {
      try {
        return await read(combined);
      } catch (error) {
        if (combined.aborted) break;
        const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : null;
        // Sleeping hosts can return an HTML loading page instead of JSON.
        const transient = error instanceof TypeError || error instanceof SyntaxError || (status !== null && status >= 500);
        if (!transient) throw error;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          combined.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, 3_000);
        combined.addEventListener('abort', done, { once: true });
        if (combined.aborted) done();
      });
    }
    if (signal.aborted) throw signal.reason;
    throw new Error('The demo server is taking longer than expected. Please try again. Your saved sales are still on this device.');
  } finally {
    clearTimeout(timeout);
  }
}
