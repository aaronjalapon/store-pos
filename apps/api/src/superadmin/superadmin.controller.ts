import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  superadminCreateStoreSchema,
  superadminResetStaffSecretSchema,
  superadminStaffInputSchema,
  superadminStaffStatusSchema,
  superadminStoreStatusSchema,
  type SuperadminCreateStoreRequest,
  type SuperadminStaffInput,
} from '@gma/contracts';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';

@Controller('superadmin')
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles('superadmin')
export class SuperadminController {
  constructor(private readonly auth: AuthService) {}

  @Get('stores')
  async listStores() {
    return { stores: await this.auth.listSuperadminStores() };
  }

  @Post('stores')
  createStore(@Req() request: Request, @Body() body: SuperadminCreateStoreRequest) {
    const result = superadminCreateStoreSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.createStoreAsSuperadmin(result.data, request.principal!);
  }

  @Post('stores/:storeId/staff')
  createStaff(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: SuperadminStaffInput,
  ) {
    const result = superadminStaffInputSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.createStoreStaffAsSuperadmin(storeId, result.data, request.principal!);
  }

  @Get('stores/:storeId')
  details(@Param('storeId', new ParseUUIDPipe()) storeId: string) {
    return this.auth.getSuperadminStoreDetails(storeId);
  }

  @Patch('stores/:storeId/status')
  updateStoreStatus(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: unknown,
  ) {
    const result = superadminStoreStatusSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.setSuperadminStoreStatus(storeId, result.data.isActive, request.principal!);
  }

  @Delete('stores/:storeId')
  deleteStore(@Param('storeId', new ParseUUIDPipe()) storeId: string) {
    return this.auth.deleteStoreAsSuperadmin(storeId);
  }

  @Patch('stores/:storeId/staff/:userId/status')
  updateStaffStatus(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: unknown,
  ) {
    const result = superadminStaffStatusSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.setSuperadminStaffStatus(storeId, userId, result.data.isActive, request.principal!);
  }

  @Patch('stores/:storeId/staff/:userId/reset-secret')
  resetStaffSecret(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: unknown,
  ) {
    const result = superadminResetStaffSecretSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.resetSuperadminStaffSecret(storeId, userId, result.data.password, request.principal!);
  }
}
