import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
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

  const adapter = new FastifyAdapter({ bodyLimit: 12 * 1024 * 1024 });
  adapter.getInstance().addContentTypeParser(
    ['image/webp', 'image/jpeg'],
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
  );
  await app.get(AuthService).ensureConfiguredSuperadmin();
  const config = app.get(ConfigService);
  app.enableCors({
    origin: config.get('CORS_ORIGIN', 'http://localhost:3000').split(','),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  await app.listen(Number(config.get<string>('PORT') ?? 4000), '0.0.0.0');
  Logger.log(`API listening on ${await app.getUrl()}`, 'Bootstrap');
}

void bootstrap();
