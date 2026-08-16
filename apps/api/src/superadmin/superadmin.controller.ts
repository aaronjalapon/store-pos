import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
  createStore(@Body() body: SuperadminCreateStoreRequest) {
    const result = superadminCreateStoreSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.createStoreAsSuperadmin(result.data);
  }

  @Post('stores/:storeId/staff')
  createStaff(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: SuperadminStaffInput,
  ) {
    const result = superadminStaffInputSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.createStoreStaffAsSuperadmin(storeId, result.data);
  }

  @Get('stores/:storeId')
  details(@Param('storeId', new ParseUUIDPipe()) storeId: string) {
    return this.auth.getSuperadminStoreDetails(storeId);
  }

  @Patch('stores/:storeId/status')
  updateStoreStatus(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: unknown,
  ) {
    const result = superadminStoreStatusSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.setSuperadminStoreStatus(storeId, result.data.isActive);
  }

  @Patch('stores/:storeId/staff/:userId/status')
  updateStaffStatus(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: unknown,
  ) {
    const result = superadminStaffStatusSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.setSuperadminStaffStatus(storeId, userId, result.data.isActive);
  }

  @Patch('stores/:storeId/staff/:userId/reset-secret')
  resetStaffSecret(
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: unknown,
  ) {
    const result = superadminResetStaffSecretSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.resetSuperadminStaffSecret(storeId, userId, result.data.password);
  }
}
