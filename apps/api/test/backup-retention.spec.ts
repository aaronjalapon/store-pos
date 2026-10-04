import { BackupsService } from '../src/backups/backups.service';

describe('backup recovery window', () => {
  it('preserves distinct Manila days and months despite frequent manual backups', async () => {
    const rows = Array.from({ length: 45 }, (_, day) => ({
      id: `day-${day}`, object_key: `daily/${day}`,
      created_at: new Date(Date.UTC(2026, 9, 4 - day, 0)),
    }));
    // 35 newer backups on the same local day must not evict daily recovery points.
    rows.unshift(...Array.from({ length: 35 }, (_, index) => ({
      id: `manual-${index}`, object_key: `manual/${index}`,
      created_at: new Date(Date.UTC(2026, 9, 4, 7, 59 - index)),
    })));
    const query = jest.fn(async () => ({ rows }));
    const expired: string[] = [];
    const client = { query: jest.fn(async (sql: string, values: string[]) => {
      if (sql.startsWith('UPDATE backups')) expired.push(values[0]);
      return { rows: [] };
    }) };
    const database = { query, transaction: (work: (value: typeof client) => Promise<void>) => work(client) };
    await new BackupsService(database as never, {} as never, {} as never).applyRetention('store');
    expect(expired).not.toContain('manual-0');
    for (let day = 1; day < 30; day += 1) expect(expired).not.toContain(`day-${day}`);
    expect(expired).toContain('manual-1');
    expect(expired).toContain('day-0');
    expect(expired).toContain('day-31');
    expect(expired).not.toContain('day-34'); // newest August recovery point
  });

  it('retains the latest twelve monthly recovery points and expires older duplicates', async () => {
    const rows = Array.from({ length: 14 }, (_, month) => ({
      id: `month-${month}`, object_key: `monthly/${month}`,
      created_at: new Date(Date.UTC(2026, 9 - month, 4)),
    }));
    // Fill the daily window so monthly-only records exercise the monthly limit.
    rows.unshift(...Array.from({ length: 30 }, (_, day) => ({
      id: `recent-${day}`, object_key: `recent/${day}`,
      created_at: new Date(Date.UTC(2026, 9, 4 - day, 8)),
    })));
    rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    const expired: string[] = [];
    const client = { query: async (sql: string, values: string[]) => {
      if (sql.startsWith('UPDATE backups')) expired.push(values[0]);
      return { rows: [] };
    } };
    const database = { query: async () => ({ rows }), transaction: (work: (value: typeof client) => Promise<void>) => work(client) };
    await new BackupsService(database as never, {} as never, {} as never).applyRetention('store');
    for (let month = 2; month < 12; month += 1) expect(expired).not.toContain(`month-${month}`);
    expect(expired).toContain('month-12');
    expect(expired).toContain('month-13');
  });

  it('uses Manila midnight instead of UTC midnight for daily selection', async () => {
    const rows = [
      { id: 'after', object_key: 'after', created_at: new Date('2026-10-03T16:01:00Z') },
      { id: 'before', object_key: 'before', created_at: new Date('2026-10-03T15:59:00Z') },
    ];
    const transaction = jest.fn();
    await new BackupsService({ query: async () => ({ rows }), transaction } as never, {} as never, {} as never).applyRetention('store');
    expect(transaction).not.toHaveBeenCalled();
  });
});
