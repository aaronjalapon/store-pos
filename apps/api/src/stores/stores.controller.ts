import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { StoresService } from './stores.service';
import { legacyImportRequestSchema } from './legacy-import.schema';
import { BadRequestException } from '@nestjs/common';

@Controller('stores/:storeId')
@UseGuards(SessionAuthGuard)
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get('bootstrap')
  bootstrap(
    @Req() request: Request,
    @Headers('authorization') authorization: string,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
  ) {
    this.assertStoreScope(request, storeId);
    return this.stores.bootstrap(request.principal!, authorization.slice(7));
  }

  @Get('sync')
  sync(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Headers('x-pos-sync-version') syncVersion?: string,
    @Query('cursor') cursor = '0',
  ) {
    this.assertStoreScope(request, storeId);
    return syncVersion === '2'
      ? this.stores.syncV2(request.principal!, Number.isSafeInteger(Number(cursor)) ? Math.max(0, Number(cursor)) : 0)
      : this.stores.sync(request.principal!);
  }

  @Post('import-legacy')
  importLegacy(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: unknown,
  ) {
    this.assertStoreScope(request, storeId);
    const result = legacyImportRequestSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.stores.importLegacy(request.principal!, result.data.snapshot);
  }

  private assertStoreScope(request: Request, storeId: string) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
  }
}
