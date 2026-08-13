import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { StoreSnapshot } from '@gma/contracts';
import type { FastifyRequest } from 'fastify';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { StoresService } from './stores.service';

@Controller('stores/:storeId')
@UseGuards(SessionAuthGuard)
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get('bootstrap')
  bootstrap(
    @Req() request: FastifyRequest,
    @Headers('authorization') authorization: string,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
  ) {
    this.assertStoreScope(request, storeId);
    return this.stores.bootstrap(request.principal!, authorization.slice(7));
  }

  @Get('sync')
  sync(
    @Req() request: FastifyRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
  ) {
    this.assertStoreScope(request, storeId);
    return this.stores.sync(request.principal!);
  }

  @Post('import-legacy')
  importLegacy(
    @Req() request: FastifyRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: { snapshot: StoreSnapshot },
  ) {
    this.assertStoreScope(request, storeId);
    return this.stores.importLegacy(request.principal!, body.snapshot);
  }

  private assertStoreScope(request: FastifyRequest, storeId: string) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
  }
}
