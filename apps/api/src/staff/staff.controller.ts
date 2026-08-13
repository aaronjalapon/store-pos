import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createStaffSchema,
  resetStaffSecretSchema,
  type CreateStaffRequest,
  type ResetStaffSecretRequest,
} from '@gma/contracts';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../auth/auth.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';

@Controller('stores/:storeId/staff')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles('owner', 'admin')
export class StaffController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  list(@Req() request: FastifyRequest, @Param('storeId', new ParseUUIDPipe()) storeId: string) {
    this.assertStoreScope(request, storeId);
    return this.auth.listStaff(storeId).then((staff) => ({ staff }));
  }

  @Post()
  create(
    @Req() request: FastifyRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: CreateStaffRequest,
  ) {
    this.assertStoreScope(request, storeId);
    const result = createStaffSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.createStaff(storeId, request.principal!, result.data).then((staff) => ({ staff }));
  }

  @Patch(':userId/disable')
  disable(
    @Req() request: FastifyRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    this.assertStoreScope(request, storeId);
    return this.auth.disableStaff(storeId, request.principal!, userId).then((staff) => ({ staff }));
  }

  @Patch(':userId/reset-secret')
  resetSecret(
    @Req() request: FastifyRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: ResetStaffSecretRequest,
  ) {
    this.assertStoreScope(request, storeId);
    const result = resetStaffSecretSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.resetStaffSecret(storeId, request.principal!, userId, result.data).then((staff) => ({ staff }));
  }

  private assertStoreScope(request: FastifyRequest, storeId: string) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
  }
}
