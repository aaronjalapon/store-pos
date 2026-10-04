import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { resolveEnvPath } from '../config/resolve-env-path';
import { BackupRestoreService } from './backup-restore.service';

loadEnv({ path: resolveEnvPath() });

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const storeId = argument('--store-id');
  const backupId = argument('--backup-id');
  const dryRun = process.argv.includes('--dry-run');
  if (!storeId || !backupId) throw new Error('Usage: --store-id <uuid> --backup-id <uuid> [--dry-run | --confirm RESTORE:<store-id>]');
  if (!dryRun && argument('--confirm') !== `RESTORE:${storeId}`) throw new Error(`Pass --confirm RESTORE:${storeId} to perform the restore`);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(BackupRestoreService).restore(storeId, backupId, { dryRun });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
