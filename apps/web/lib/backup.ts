'use client';

import { createServerBackup, getBackupStatus as fetchBackupStatus } from './api';

export async function getBackupStatus() {
  return fetchBackupStatus();
}

export async function createAndUploadBackup() {
  return createServerBackup();
}
