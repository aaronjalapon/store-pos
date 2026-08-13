import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { ProductImagesService } from './product-images.service';

@Controller('stores/:storeId/products/:productId/images')
@UseGuards(SessionAuthGuard)
export class ProductImagesController {
  constructor(private readonly images: ProductImagesService) {}

  @Put(':revision')
  put(
    @Req() request: FastifyRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('revision', new ParseUUIDPipe()) revision: string,
    @Headers('content-type') contentType: string,
    @Body() body: Buffer,
  ) {
    this.assertStoreScope(request, storeId);
    return this.images.put(request.principal!, productId, revision, body, contentType || '');
  }

  @Get(':revision')
  async get(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('revision', new ParseUUIDPipe()) revision: string,
  ) {
    this.assertStoreScope(request, storeId);
    const object = await this.images.get(request.principal!, productId, revision);
    reply.header('content-type', object.contentType);
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return Buffer.from(object.body);
  }

  @Delete(':revision')
  delete(
    @Req() request: FastifyRequest,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('productId', new ParseUUIDPipe()) productId: string,
    @Param('revision', new ParseUUIDPipe()) revision: string,
  ) {
    this.assertStoreScope(request, storeId);
    return this.images.delete(request.principal!, productId, revision);
  }

  private assertStoreScope(request: FastifyRequest, storeId: string) {
    if (request.principal?.storeId !== storeId) throw new ForbiddenException('You do not have access to this store');
  }
}
