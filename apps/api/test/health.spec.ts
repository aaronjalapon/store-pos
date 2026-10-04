import { HealthController } from '../src/health/health.controller';

describe('dependency readiness', () => {
  it('times out stalled dependencies, shares probes, and recovers without affecting liveness', async () => {
    jest.useFakeTimers();
    let resume!: () => void;
    const storage = { check: jest.fn().mockImplementationOnce(() => new Promise<void>(resolve => { resume = resolve; })).mockResolvedValue(undefined) };
    const database = { query: jest.fn().mockResolvedValue({ rows: [{ migration: '010_sync_retention_state.sql' }] }) };
    const health = new HealthController(database as never, storage as never);
    try {
      const failed = expect(health.ready()).rejects.toMatchObject({ status: 503 });
      const concurrent = expect(health.ready()).rejects.toMatchObject({ status: 503 });
      await jest.advanceTimersByTimeAsync(3000);
      await Promise.all([failed, concurrent]);
      expect(database.query).toHaveBeenCalledTimes(1);
      expect(storage.check).toHaveBeenCalledTimes(1);
      expect(health.health().status).toBe('ok');
      resume();
      await jest.advanceTimersByTimeAsync(0);
      await expect(health.ready()).resolves.toMatchObject({ status: 'ready' });
      expect(database.query).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  it('rejects outdated schemas and unavailable databases', async () => {
    const database = { query: jest.fn().mockResolvedValueOnce({ rows: [{ migration: '009_production_readiness.sql' }] }).mockRejectedValueOnce(new Error('unavailable')) };
    const health = new HealthController(database as never, { check: async () => undefined } as never);
    await expect(health.ready()).rejects.toMatchObject({ status: 503 });
    await expect(health.ready()).rejects.toMatchObject({ status: 503 });
  });
});
