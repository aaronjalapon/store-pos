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
  Headers,
} from '@nestjs/common';
import { storeCommandRequestSchema, type StoreCommandRequest } from '@gma/contracts';
import type { Request } from 'express';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { PosService } from './pos.service';

@Controller('stores/:storeId/commands')
@UseGuards(SessionAuthGuard)
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Post()
  apply(
    @Req() request: Request,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body() body: StoreCommandRequest,
    @Headers('x-pos-sync-version') syncVersion?: string,
  ) {
    this.assertStoreScope(request, storeId);
    const result = storeCommandRequestSchema.safeParse(body);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid sync command',
        errors: result.error.flatten(),
        issues: result.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
    }
    return this.pos.applyCommand(request.principal!, result.data, syncVersion !== '2');
  }

  private assertStoreScope(request: Request, storeId: string) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
  }
}
