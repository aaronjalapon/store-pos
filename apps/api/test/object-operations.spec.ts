import { Logger } from '@nestjs/common';
import { ObjectOperationsService } from '../src/storage/object-operations.service';

const operation = { id: 'op', status: 'pending', operation: 'finalize', object_kind: 'backup',
  staging_key: 'staging/backup', final_key: 'backups/final', content_type: 'application/json', attempt_count: 0 };

describe('durable object finalization', () => {
  it('keeps staging after a database failure, retries, then cleans up after committed completion', async () => {
    let current = { ...operation };
    let failCommit = true;
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: current.staging_key ? [{ ...current }] : [] };
      if (sql.includes("status = 'failed'")) current.status = 'failed';
      if (sql.includes('SET staging_key = NULL')) current.staging_key = '';
      return { rows: [] };
    });
    const database = { query, transaction: jest.fn(async (work) => {
      if (failCommit) throw new Error('connection lost before commit');
      await work({ query: async () => ({ rows: [] }) });
      current.status = 'complete';
    }) };
    const storage = { copy: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) };
    const service = new ObjectOperationsService(database as never, storage as never);
    await service.reconcile();
    expect(current.status).toBe('failed');
    expect(storage.delete).not.toHaveBeenCalled();
    failCommit = false;
    await service.reconcile();
    expect(current.status).toBe('complete');
    expect(storage.copy).toHaveBeenCalledTimes(2);
    expect(storage.delete).not.toHaveBeenCalled();
    await service.reconcile();
    expect(storage.delete).toHaveBeenCalledWith('staging/backup');
    expect(current.staging_key).toBe('');
  });

  it('contains scheduled database-outage failures and retries on the next interval', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const query = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ rows: [] });
    const service = new ObjectOperationsService({ query } as never, {} as never);
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(warn).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(query).toHaveBeenCalledTimes(2);
    } finally { service.onModuleDestroy(); jest.useRealTimers(); warn.mockRestore(); }
  });
});

import { BackupSchedulerService } from '../src/backups/backup-scheduler.service';

describe('scheduled backup availability', () => {
  it('contains a database outage and schedules the next Manila daily run', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-04T17:59:59Z') });
    const warn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const query = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ rows: [] });
    const service = new BackupSchedulerService({ query } as never, {} as never);
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(1000);
      expect(warn).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(query).toHaveBeenCalledTimes(2);
    } finally { service.onModuleDestroy(); jest.useRealTimers(); warn.mockRestore(); }
  });
});
