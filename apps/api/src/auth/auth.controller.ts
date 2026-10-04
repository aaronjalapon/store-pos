import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  cashierLoginSchema,
  deviceEnrollmentDecisionSchema,
  managerActionConfirmationSchema,
  ownerLoginSchema,
  setupOwnerSchema,
  type CashierLoginRequest,
  type ManagerActionConfirmationRequest,
  type OwnerLoginRequest,
  type SetupOwnerRequest,
} from '@gma/contracts';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { SessionAuthGuard } from './session-auth.guard';

const REFRESH_COOKIE = 'gma_pos_refresh';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limits: AuthRateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Get('setup-status')
  setupStatus() {
    return this.auth.getSetupStatus();
  }

  @Post('setup-owner')
  async setupOwner(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: SetupOwnerRequest) {
    const result = setupOwnerSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    const ip = this.clientIp(request);
    await this.limits.assertAllowed({ action: 'setup', key: ip, limit: 5, windowSeconds: 3600, blockSeconds: 3600 });
    const issued = await this.auth.setupOwner(result.data);
    this.setRefreshCookie(response, issued.refreshToken);
    return issued.session;
  }

  @Post('login')
  @HttpCode(200)
  async login(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: OwnerLoginRequest) {
    const result = ownerLoginSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    const ip = this.clientIp(request);
    const account = result.data.email.toLowerCase();
    await this.limits.assertAllowed(
      { action: 'owner_ip', key: ip, limit: 30, windowSeconds: 900, blockSeconds: 900 },
      { action: 'owner_account', key: account, limit: 5, windowSeconds: 900, blockSeconds: 900 },
    );
    const issued = await this.auth.loginOwnerOrAdmin(result.data);
    await this.limits.reset({ action: 'owner_account', key: account });
    this.setRefreshCookie(response, issued.refreshToken);
    return issued.session;
  }

  @Post('cashier-login')
  @HttpCode(200)
  async cashierLogin(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: CashierLoginRequest) {
    const result = cashierLoginSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    const ip = this.clientIp(request);
    const account = `${result.data.storeId}:${result.data.staffCode.toLowerCase()}`;
    await this.limits.assertAllowed(
      { action: 'cashier_ip', key: ip, limit: 30, windowSeconds: 300, blockSeconds: 600 },
      { action: 'cashier_account', key: account, limit: 10, windowSeconds: 300, blockSeconds: 900 },
    );
    const issued = await this.auth.loginCashier(result.data);
    await this.limits.reset({ action: 'cashier_account', key: account });
    this.setRefreshCookie(response, issued.refreshToken);
    return issued.session;
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const refreshToken = request.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!refreshToken) throw new BadRequestException('Refresh cookie required');
    const issued = await this.auth.refresh(refreshToken);
    this.setRefreshCookie(response, issued.refreshToken);
    return issued.session;
  }

  @Post('logout')
  @UseGuards(SessionAuthGuard)
  @HttpCode(200)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.logout(request.principal!);
    response.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
    return result;
  }

  @Post('confirm-manager-action')
  @UseGuards(SessionAuthGuard)
  async confirmManagerAction(@Req() request: Request, @Body() body: ManagerActionConfirmationRequest) {
    const result = managerActionConfirmationSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    await this.limits.assertAllowed({
      action: 'manager_confirmation', key: `${request.principal!.userId}:${this.clientIp(request)}`,
      limit: 5, windowSeconds: 600, blockSeconds: 900,
    });
    return this.auth.confirmManagerAction(request.principal!, result.data);
  }

  @Get('device-enrollments')
  @UseGuards(SessionAuthGuard)
  listDeviceEnrollments(@Req() request: Request) {
    return this.auth.listPendingDeviceEnrollments(request.principal!);
  }

  @Post('device-enrollments/:challengeId/decision')
  @UseGuards(SessionAuthGuard)
  decideDeviceEnrollment(
    @Req() request: Request,
    @Param('challengeId') challengeId: string,
    @Body() body: unknown,
  ) {
    const result = deviceEnrollmentDecisionSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.auth.decideDeviceEnrollment(request.principal!, challengeId, result.data.approve);
  }

  @Post('devices/:deviceId/revoke')
  @UseGuards(SessionAuthGuard)
  revokeDevice(@Req() request: Request, @Param('deviceId') deviceId: string) {
    return this.auth.revokeDevice(request.principal!, deviceId);
  }

  @Get('me')
  @UseGuards(SessionAuthGuard)
  me(@Req() request: Request, @Headers('authorization') authorization: string) {
    return this.auth.buildSession(request.principal!, authorization.slice(7));
  }

  private clientIp(request: Request) {
    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  private setRefreshCookie(response: Response, token: string) {
    response.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: '/v1/auth',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
}
