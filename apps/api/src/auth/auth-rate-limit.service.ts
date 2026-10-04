import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';

interface LimitPolicy {
  action: string;
  key: string;
  limit: number;
  windowSeconds: number;
  blockSeconds: number;
}

@Injectable()
export class AuthRateLimitService {
  constructor(private readonly database: DatabaseService) {}

  async assertAllowed(...policies: LimitPolicy[]) {
    for (const policy of policies) {
      const keyHash = createHash('sha256').update(`${policy.action}:${policy.key}`).digest('hex');
      const result = await this.database.query<{
        attempt_count: number;
        blocked_until: Date | null;
      }>(
        `INSERT INTO auth_rate_limits
           (key_hash, action, window_started_at, attempt_count, blocked_until, updated_at)
         VALUES ($1, $2, now(), 1, NULL, now())
         ON CONFLICT (key_hash) DO UPDATE SET
           action = EXCLUDED.action,
           window_started_at = CASE
             WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $3)
             THEN now() ELSE auth_rate_limits.window_started_at END,
           attempt_count = CASE
             WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $3)
             THEN 1 ELSE auth_rate_limits.attempt_count + 1 END,
           blocked_until = CASE
             WHEN auth_rate_limits.blocked_until > now() THEN auth_rate_limits.blocked_until
             WHEN (CASE
               WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $3)
               THEN 1 ELSE auth_rate_limits.attempt_count + 1 END) > $4
             THEN now() + make_interval(secs => $5)
             ELSE NULL END,
           updated_at = now()
         RETURNING attempt_count, blocked_until`,
        [keyHash, policy.action, policy.windowSeconds, policy.limit, policy.blockSeconds],
      );
      const blockedUntil = result.rows[0]?.blocked_until;
      if (blockedUntil && blockedUntil.getTime() > Date.now()) {
        const retryAfter = Math.max(1, Math.ceil((blockedUntil.getTime() - Date.now()) / 1000));
        throw new HttpException({
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many attempts. Try again later.',
          code: 'rate_limited',
          retryAfter,
        }, HttpStatus.TOO_MANY_REQUESTS);
      }
    }
  }

  async reset(...policies: Pick<LimitPolicy, 'action' | 'key'>[]) {
    if (!policies.length) return;
    const hashes = policies.map((policy) => createHash('sha256').update(`${policy.action}:${policy.key}`).digest('hex'));
    await this.database.query('DELETE FROM auth_rate_limits WHERE key_hash::text = ANY($1::text[])', [hashes]);
  }

  async prune() {
    await this.database.query("DELETE FROM auth_rate_limits WHERE updated_at < now() - interval '2 days'");
  }
}
