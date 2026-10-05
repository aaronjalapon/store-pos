import { Body, Controller, Delete, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PaymentSettingsService } from './payment-settings.service';

@Controller('stores/:storeId/payment-settings/qrph')
@UseGuards(SessionAuthGuard)
export class PaymentSettingsController {
  constructor(private readonly settings: PaymentSettingsService) {}

  @Put(':revision')
  put(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('revision', new ParseUUIDPipe()) revision: string,
    @Headers('content-type') contentType: string,
    @Body() body: Buffer,
  ) {
    this.assertStoreScope(request, storeId);
    return this.settings.putQr(request.principal!, revision, body, contentType || '');
  }

  @Get(':revision')
  async get(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('revision', new ParseUUIDPipe()) revision: string,
  ) {
    this.assertStoreScope(request, storeId);
    const object = await this.settings.getQr(request.principal!, revision);
    response.setHeader('content-type', object.contentType);
    response.setHeader('cache-control', 'private, no-store');
    return Buffer.from(object.body);
  }

  @Delete(':revision')
  delete(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('revision', new ParseUUIDPipe()) revision: string,
  ) {
    this.assertStoreScope(request, storeId);
    return this.settings.deleteQr(request.principal!, revision);
  }

  private assertStoreScope(request: Request, storeId: string) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
  }
}
