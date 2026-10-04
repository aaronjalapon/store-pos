import { Controller, ForbiddenException, Get, Headers, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DatabaseService } from '../database/database.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly config: ConfigService, private readonly database: DatabaseService) {}

  @Get()
  async metrics(@Headers('x-metrics-token') token: string | undefined, @Res() response: Response) {
    const expected = this.config.get<string>('METRICS_TOKEN');
    if (expected && token !== expected) throw new ForbiddenException('Metrics token is invalid');
    if (!expected && this.config.get('NODE_ENV') === 'production') throw new ForbiddenException('Metrics are not configured');
    const operational = await this.database.query<{
      pending_commands: string;
      pending_objects: string;
      stale_backups: string;
      blocked_auth_buckets: string;
      oldest_object_age_seconds: string;
      stale_restore_drills: string;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM processed_commands WHERE result_json IS NULL)::text AS pending_commands,
        (SELECT COUNT(*) FROM object_operations WHERE status IN ('pending', 'failed'))::text AS pending_objects,
        (SELECT COUNT(*) FROM stores s WHERE s.is_active AND NOT EXISTS (
          SELECT 1 FROM backups b WHERE b.store_id = s.id AND b.status = 'complete' AND b.created_at > now() - interval '36 hours'
        ))::text AS stale_backups,
        (SELECT COUNT(*) FROM auth_rate_limits WHERE blocked_until > now())::text AS blocked_auth_buckets,
        COALESCE((SELECT EXTRACT(EPOCH FROM now() - MIN(created_at))::bigint
          FROM object_operations WHERE status IN ('pending', 'failed')), 0)::text AS oldest_object_age_seconds,
        (SELECT COUNT(*) FROM stores s WHERE s.is_active AND NOT EXISTS (
          SELECT 1 FROM backups b WHERE b.store_id = s.id AND b.restore_verified_at > now() - interval '90 days'
        ))::text AS stale_restore_drills`,
    );
    const row = operational.rows[0];
    const metrics = [
      '# HELP gma_pos_process_uptime_seconds Time the API process has been running.',
      '# TYPE gma_pos_process_uptime_seconds gauge',
      `gma_pos_process_uptime_seconds ${process.uptime()}`,
      '# HELP gma_pos_process_resident_memory_bytes Resident memory used by the API process.',
      '# TYPE gma_pos_process_resident_memory_bytes gauge',
      `gma_pos_process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '# TYPE gma_pos_pending_commands gauge',
      `gma_pos_pending_commands ${Number(row?.pending_commands ?? 0)}`,
      '# TYPE gma_pos_pending_object_operations gauge',
      `gma_pos_pending_object_operations ${Number(row?.pending_objects ?? 0)}`,
      '# TYPE gma_pos_stores_with_stale_backups gauge',
      `gma_pos_stores_with_stale_backups ${Number(row?.stale_backups ?? 0)}`,
      '# TYPE gma_pos_blocked_auth_buckets gauge',
      `gma_pos_blocked_auth_buckets ${Number(row?.blocked_auth_buckets ?? 0)}`,
      '# TYPE gma_pos_oldest_object_operation_age_seconds gauge',
      `gma_pos_oldest_object_operation_age_seconds ${Number(row?.oldest_object_age_seconds ?? 0)}`,
      '# TYPE gma_pos_stores_with_stale_restore_drills gauge',
      `gma_pos_stores_with_stale_restore_drills ${Number(row?.stale_restore_drills ?? 0)}`,
    ].join('\n');
    response.type('text/plain; version=0.0.4; charset=utf-8').send(`${metrics}\n`);
  }
}
