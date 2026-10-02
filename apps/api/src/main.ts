import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { resolveEnvPath } from './config/resolve-env-path';
import { runMigrations } from './database/run-migrations';

loadEnv({ path: resolveEnvPath() });

async function bootstrap() {
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
  app.use(raw({ type: ['image/png', 'image/webp', 'image/jpeg'], limit: '12mb' }));
  app.use(json({ limit: '12mb' }));
  app.use(urlencoded({ extended: true, limit: '12mb' }));
  await app.get(AuthService).ensureConfiguredSuperadmin();
  const config = app.get(ConfigService);
  app.enableCors({
    origin: config.get('CORS_ORIGIN', 'http://localhost:3000').split(','),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  await app.listen(Number(config.get<string>('PORT') ?? 4000), '0.0.0.0');
  Logger.log(`API listening on ${await app.getUrl()}`, 'Bootstrap');
}

void bootstrap();
