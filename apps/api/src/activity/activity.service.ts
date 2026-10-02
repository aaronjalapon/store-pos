import { Injectable } from '@nestjs/common';
import type {
  ActivityCategory,
  ActivityLog,
  ActivityLogFilters,
  ActivityLogListResponse,
  Role,
} from '@gma/contracts';
import type { SessionPrincipal } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';

type QueryClient = { query: DatabaseService['query'] };

interface ActivityRow {
  id: string;
  store_id: string;
  actor_user_id: string | null;
  actor_display_name_snapshot: string;
  actor_role_snapshot: Role;
  submitted_by_user_id: string | null;
  submitted_by_display_name_snapshot: string | null;
  submitted_by_role_snapshot: Role | null;
  device_id: string | null;
  device_name_snapshot: string | null;
  category: ActivityCategory;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
  details: Record<string, unknown>;
  client_command_id: string | null;
  occurred_at: Date;
  confirmed_at: Date;
}

export interface RecordActivityInput {
  storeId: string;
  actor: SessionPrincipal;
  submittedBy?: SessionPrincipal | null;
  category: ActivityCategory;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
  clientCommandId?: string | null;
  occurredAt?: string | Date;
}

@Injectable()
export class ActivityService {
  constructor(private readonly database: DatabaseService) {}

  async record(client: QueryClient, input: RecordActivityInput) {
    const deviceId = input.actor.deviceId || input.submittedBy?.deviceId || null;
    const device = deviceId
      ? await client.query<{ name: string }>('SELECT name FROM devices WHERE id = $1 AND store_id = $2', [deviceId, input.storeId])
      : { rows: [] as { name: string }[] };
    const submittedBy = input.submittedBy && input.submittedBy.userId !== input.actor.userId
      ? input.submittedBy
      : null;
    await client.query(
      `INSERT INTO activity_logs
       (store_id, actor_user_id, actor_display_name_snapshot, actor_role_snapshot,
        submitted_by_user_id, submitted_by_display_name_snapshot, submitted_by_role_snapshot,
        device_id, device_name_snapshot, category, action, entity_type, entity_id, summary,
        details, client_command_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
       ON CONFLICT (store_id, device_id, client_command_id)
       WHERE client_command_id IS NOT NULL DO NOTHING`,
      [
        input.storeId,
        input.actor.userId || null,
        input.actor.displayName,
        input.actor.role,
        submittedBy?.userId ?? null,
        submittedBy?.displayName ?? null,
        submittedBy?.role ?? null,
        deviceId,
        device.rows[0]?.name ?? null,
        input.category,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        input.summary,
        JSON.stringify(input.details ?? {}),
        input.clientCommandId ?? null,
        input.occurredAt ?? new Date(),
      ],
    );
  }

  async recordNow(input: RecordActivityInput) {
    return this.record(this.database, input);
  }

  async list(storeId: string, filters: ActivityLogFilters): Promise<ActivityLogListResponse> {
    const values: unknown[] = [storeId];
    const where = ['store_id = $1'];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      where.push(clause.replace('?', `$${values.length}`));
    };

    if (filters.cursor) add('id < ?::bigint', filters.cursor);
    if (filters.category) add('category = ?', filters.category);
    if (filters.actorUserId) add('actor_user_id = ?::uuid', filters.actorUserId);
    if (filters.role) add('actor_role_snapshot = ?', filters.role);
    if (filters.from) add('occurred_at >= ?::timestamptz', filters.from);
    if (filters.to) add('occurred_at <= ?::timestamptz', filters.to);
    if (filters.q) {
      values.push(`%${filters.q}%`);
      const parameter = `$${values.length}`;
      where.push(`(summary ILIKE ${parameter} OR action ILIKE ${parameter} OR actor_display_name_snapshot ILIKE ${parameter})`);
    }

    const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
    values.push(limit + 1);
    const result = await this.database.query<ActivityRow>(
      `SELECT * FROM activity_logs
        WHERE ${where.join(' AND ')}
        ORDER BY id DESC
        LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    return {
      activity: rows.map((row) => this.map(row)),
      nextCursor: hasMore ? rows.at(-1)?.id ?? null : null,
    };
  }

  private map(row: ActivityRow): ActivityLog {
    return {
      id: row.id,
      storeId: row.store_id,
      actor: {
        userId: row.actor_user_id ?? '',
        displayName: row.actor_display_name_snapshot,
        role: row.actor_role_snapshot,
      },
      submittedBy: row.submitted_by_display_name_snapshot && row.submitted_by_role_snapshot
        ? {
          userId: row.submitted_by_user_id ?? '',
          displayName: row.submitted_by_display_name_snapshot,
          role: row.submitted_by_role_snapshot,
        }
        : null,
      deviceId: row.device_id,
      deviceName: row.device_name_snapshot,
      category: row.category,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      details: row.details ?? {},
      clientCommandId: row.client_command_id,
      status: 'confirmed',
      occurredAt: row.occurred_at.toISOString(),
      confirmedAt: row.confirmed_at.toISOString(),
    };
  }
}
