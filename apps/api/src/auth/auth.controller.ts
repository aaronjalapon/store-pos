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
  ownerLoginSchema,
  setupOwnerSchema,
  type CashierLoginRequest,
  type OwnerLoginRequest,
  type SetupOwnerRequest,
} from '@gma/contracts';
import type { FastifyRequest } from 'fastify';
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
  logout() {
    return { loggedOut: true as const };
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@Req() request: FastifyRequest, @Headers('authorization') authorization: string) {
    return this.auth.buildSession(request.principal!, authorization.slice(7));
  }
}
