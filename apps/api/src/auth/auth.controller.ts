import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  cashierLoginSchema,
  managerActionConfirmationSchema,
  ownerLoginSchema,
  setupOwnerSchema,
  type CashierLoginRequest,
  type ManagerActionConfirmationRequest,
  type OwnerLoginRequest,
  type SetupOwnerRequest,
} from '@gma/contracts';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from './session-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get('setup-status')
  setupStatus() {
    return this.auth.getSetupStatus();
  }

  @Post('setup-owner')
  setupOwner(@Body() body: SetupOwnerRequest) {
    const result = setupOwnerSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.setupOwner(result.data);
  }

  @Post('login')
  login(@Body() body: OwnerLoginRequest) {
    const result = ownerLoginSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.loginOwnerOrAdmin(result.data);
  }

  @Post('cashier-login')
  cashierLogin(@Body() body: CashierLoginRequest) {
    const result = cashierLoginSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.loginCashier(result.data);
  }

  @Post('logout')
  @UseGuards(SessionAuthGuard)
  logout(@Req() request: Request) {
    return this.auth.logout(request.principal!);
  }

  @Post('confirm-manager-action')
  @UseGuards(SessionAuthGuard)
  confirmManagerAction(@Req() request: Request, @Body() body: ManagerActionConfirmationRequest) {
    const result = managerActionConfirmationSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.confirmManagerAction(request.principal!, result.data);
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@Req() request: Request, @Headers('authorization') authorization: string) {
    return this.auth.buildSession(request.principal!, authorization.slice(7));
  }
}
