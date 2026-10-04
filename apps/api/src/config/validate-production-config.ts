import { z } from 'zod';

const productionConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32).refine((value) => !value.includes('replace-with'), 'JWT_SECRET must not be a placeholder'),
  CORS_ORIGIN: z.string().min(1).refine((value) => value.split(',').every((candidate) => {
    const trimmed = candidate.trim();
    try {
      const url = new URL(trimmed);
      return url.origin === trimmed && url.protocol === 'https:';
    } catch {
      return false;
    }
  }), 'CORS_ORIGIN must contain exact comma-separated HTTPS origins without paths'),
  METRICS_TOKEN: z.string().min(24),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1).refine((value) => value !== 'minioadmin', 'Production S3 credentials must not use minioadmin'),
  S3_SECRET_KEY: z.string().min(12).refine((value) => value !== 'minioadmin', 'Production S3 credentials must not use minioadmin'),
  S3_ENDPOINT: z.string().url().optional().refine((value) => !value || value.startsWith('https://'), 'Production object storage must use HTTPS'),
  SUPERADMIN_EMAIL: z.email().optional(),
  SUPERADMIN_PASSWORD: z.string().min(16).optional().refine(
    (value) => !value || !/changeme|replace-with|password/i.test(value),
    'SUPERADMIN_PASSWORD must not be a placeholder',
  ),
  TRUST_PROXY_HOPS: z.string().regex(/^\d+$/).optional(),
  BACKUP_MAX_BYTES: z.string().regex(/^\d+$/).refine((value) => Number(value) >= 1024 * 1024, 'BACKUP_MAX_BYTES must be at least 1 MiB'),
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: z.string().min(1),
  BACKUP_ENCRYPTION_KEYS_JSON: z.string().transform((value, context) => {
    try {
      const parsed = JSON.parse(value) as Record<string, string>;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
      for (const encoded of Object.values(parsed)) {
        if (Buffer.from(encoded, 'base64').byteLength !== 32) throw new Error();
      }
      return parsed;
    } catch {
      context.addIssue({ code: 'custom', message: 'Backup keys must be a JSON object of 32-byte base64 keys' });
      return z.NEVER;
    }
  }),
}).superRefine((value, context) => {
  if (Boolean(value.SUPERADMIN_EMAIL) !== Boolean(value.SUPERADMIN_PASSWORD)) {
    context.addIssue({ code: 'custom', path: ['SUPERADMIN_EMAIL'], message: 'SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD must be configured together' });
  }
});

export function validateProductionConfig(environment: NodeJS.ProcessEnv) {
  if (environment.NODE_ENV !== 'production') return;
  const result = productionConfigSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid production configuration: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  if (!result.data.BACKUP_ENCRYPTION_KEYS_JSON[result.data.BACKUP_ENCRYPTION_ACTIVE_KEY_ID]) {
    throw new Error('Invalid production configuration: the active backup key ID is not present in BACKUP_ENCRYPTION_KEYS_JSON');
  }
}
