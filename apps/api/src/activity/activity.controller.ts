import { BadRequestException, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { activityCategories, managerRoles, roles, type ActivityLogFilters } from '@gma/contracts';
import type { Request } from 'express';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ActivityService } from './activity.service';

@Controller('stores/:storeId/activity-logs')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(...managerRoles)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
    const filters = this.parseFilters(query);
    return this.activity.list(storeId, filters);
  }

  private parseFilters(query: Record<string, string | undefined>): ActivityLogFilters {
    const filters: ActivityLogFilters = {};
    if (query.cursor) {
      if (!/^\d+$/.test(query.cursor)) throw new BadRequestException('Invalid activity cursor');
      filters.cursor = query.cursor;
    }
    if (query.limit) {
      const limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new BadRequestException('Invalid activity limit');
      filters.limit = Math.min(100, limit);
    }
    if (query.category) {
      if (!activityCategories.includes(query.category as never)) throw new BadRequestException('Invalid activity category');
      filters.category = query.category as ActivityLogFilters['category'];
    }
    if (query.actorUserId) {
      if (!/^[0-9a-f-]{36}$/i.test(query.actorUserId)) throw new BadRequestException('Invalid activity user');
      filters.actorUserId = query.actorUserId;
    }
    if (query.role) {
      if (!roles.includes(query.role as never)) throw new BadRequestException('Invalid activity role');
      filters.role = query.role as ActivityLogFilters['role'];
    }
    for (const key of ['from', 'to'] as const) {
      const value = query[key];
      if (value && Number.isNaN(Date.parse(value))) throw new BadRequestException(`Invalid ${key} date`);
      if (value) filters[key] = value;
    }
    if (query.q) filters.q = query.q.trim().slice(0, 120);
    return filters;
  }
}
