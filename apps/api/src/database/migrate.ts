import { config as loadEnv } from 'dotenv';
import { resolveEnvPath } from '../config/resolve-env-path';
import { runMigrations } from './run-migrations';

loadEnv({ path: resolveEnvPath() });

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const result = await runMigrations(databaseUrl);
  process.stdout.write(`Database migrations applied (${result.appliedCount}).\n`);
}

void migrate();
