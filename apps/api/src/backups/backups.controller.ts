import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { BackupsService } from './backups.service';

@Controller('stores/:storeId/backups')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles('owner', 'admin')
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  @Get('status')
  status(@Req() request: FastifyRequest, @Param('storeId', new ParseUUIDPipe()) storeId: string) {
    this.assertStoreScope(request, storeId);
    return this.backups.getSummary(storeId);
  }

  @Post()
  create(@Req() request: FastifyRequest, @Param('storeId', new ParseUUIDPipe()) storeId: string) {
    this.assertStoreScope(request, storeId);
    return this.backups.create(request.principal!);
  }

  private assertStoreScope(request: FastifyRequest, storeId: string) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
  }
}
