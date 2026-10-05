import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw, urlencoded } from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import crypto from 'node:crypto';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { resolveEnvPath } from './config/resolve-env-path';
import { runMigrations } from './database/run-migrations';
import { validateProductionConfig } from './config/validate-production-config';

loadEnv({ path: resolveEnvPath() });

async function bootstrap() {
  validateProductionConfig(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  await runMigrations(databaseUrl, {
    onRetry(attempt, maxAttempts, error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'UNKNOWN';
      Logger.warn(
        `Database connection attempt ${attempt}/${maxAttempts} failed with ${code}. Retrying...`,
        'Bootstrap',
      );
    },
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.use(helmet());
  app.use('/v1', (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('CDN-Cache-Control', 'no-store');
    response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    next();
  });
  app.use(pinoHttp({
    genReqId: (request, response) => {
      const existing = request.headers['x-request-id'];
      const requestId = typeof existing === 'string' && existing.length <= 100 ? existing : crypto.randomUUID();
      response.setHeader('x-request-id', requestId);
      return requestId;
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', 'req.body.password', 'req.body.pin'],
      censor: '[REDACTED]',
    },
  }));
  app.use(cookieParser());
  app.use('/v1/stores/:storeId/products/:productId/images/:revision', raw({ type: ['image/webp', 'image/jpeg'], limit: '4mb' }));
  app.use('/v1/stores/:storeId/payment-settings/qrph/:revision', raw({ type: ['image/png', 'image/webp', 'image/jpeg'], limit: '2mb' }));
  app.use('/v1/stores/:storeId/import-legacy', json({ limit: '2mb' }));
  app.use(json({ limit: '256kb' }));
  app.use(urlencoded({ extended: true, limit: '64kb' }));
  await app.get(AuthService).ensureConfiguredSuperadmin();
  const config = app.get(ConfigService);
  const corsOrigins = config.get<string>('CORS_ORIGIN', 'http://localhost:3000')
    .split(',').map((origin: string) => origin.trim()).filter(Boolean);
  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/{*path}', method: RequestMethod.ALL },
    ],
  });
  await app.listen(Number(config.get<string>('PORT') ?? 4000), '0.0.0.0');
  Logger.log(`API listening on ${await app.getUrl()}`, 'Bootstrap');
}

void bootstrap();
