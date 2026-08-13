import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  Body,
} from '@nestjs/common';
import { storeCommandRequestSchema, type StoreCommandRequest } from '@gma/contracts';
import type { FastifyRequest } from 'fastify';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PosService } from './pos.service';

@Controller('stores/:storeId/commands')
@UseGuards(SessionAuthGuard)
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Post()
  apply(
    @Req() request: FastifyRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: StoreCommandRequest,
  ) {
    this.assertStoreScope(request, storeId);
    const result = storeCommandRequestSchema.safeParse(body);
    if (!result.success) throw new BadRequestException(result.error.flatten());
    return this.pos.applyCommand(request.principal!, result.data);
  }

  private assertStoreScope(request: FastifyRequest, storeId: string) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
  }
}
