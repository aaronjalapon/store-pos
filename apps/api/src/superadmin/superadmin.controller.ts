import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  superadminCreateStoreSchema,
  superadminStaffInputSchema,
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
}
