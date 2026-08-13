import { access, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';

interface MigrationRow {
  filename: string;
  checksum_sha256: string;
}

interface RunMigrationsOptions {
  connectRetries?: number;
  retryDelayMs?: number;
  onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void;
}

const RETRYABLE_CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

export async function runMigrations(databaseUrl: string, options: RunMigrationsOptions = {}) {
  const client = await connectWithRetry(databaseUrl, options);
  try {
    await client.query('SELECT pg_advisory_lock($1)', [4_202_608_12]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum_sha256 char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<MigrationRow>('SELECT filename, checksum_sha256 FROM schema_migrations');
    const appliedChecksums = new Map(applied.rows.map((row) => [row.filename, row.checksum_sha256]));

    const migrationsDir = await resolveMigrationsDir();
    const migrations = (await readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const filename of migrations) {
      const sql = await readFile(resolve(migrationsDir, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existingChecksum = appliedChecksums.get(filename);

      if (existingChecksum === checksum) continue;
      if (existingChecksum && existingChecksum !== checksum) {
        throw new Error(`Migration ${filename} has changed after being applied. Create a new migration instead of editing an old one.`);
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum_sha256)
           VALUES ($1, $2)`,
          [filename, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return { appliedCount: migrations.length, completed: true as const };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [4_202_608_12]).catch(() => undefined);
    await client.end();
  }
}

async function connectWithRetry(databaseUrl: string, options: RunMigrationsOptions) {
  const maxAttempts = Math.max(1, options.connectRetries ?? 15);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const client = new Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (!isRetryableConnectionError(error) || attempt === maxAttempts) {
        throw error;
      }
      options.onRetry?.(attempt, maxAttempts, error);
      await sleep(retryDelayMs);
    }
  }

  throw new Error('Database connection retry loop exited unexpectedly.');
}

function isRetryableConnectionError(error: unknown) {
  return collectErrorCodes(error).some((code) => RETRYABLE_CONNECTION_CODES.has(code));
}

function collectErrorCodes(error: unknown): string[] {
  if (!error || typeof error !== 'object') return [];

  const result: string[] = [];
  if ('code' in error && typeof error.code === 'string') {
    result.push(error.code);
  }
  if ('errors' in error && Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      result.push(...collectErrorCodes(nested));
    }
  }
  return result;
}

function sleep(delayMs: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
}

async function resolveMigrationsDir() {
  const candidates = [
    resolve(process.cwd(), 'migrations'),
    resolve(__dirname, '../../migrations'),
    resolve(__dirname, '../../../migrations'),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Could not find the migrations directory. Checked: ${candidates.join(', ')}`);
}
