import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { RolesGuard } from './auth/roles.guard';
import { SessionAuthGuard } from './auth/session-auth.guard';
import { BackupsController } from './backups/backups.controller';
import { BackupsService } from './backups/backups.service';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { ObjectStorage } from './storage/object-storage';
import { S3ObjectStorage } from './storage/s3-object-storage';
import { ProductImagesController } from './product-images/product-images.controller';
import { ProductImagesService } from './product-images/product-images.service';
import { StoresController } from './stores/stores.controller';
import { StoresService } from './stores/stores.service';
import { StoreDataService } from './stores/store-data.service';
import { StaffController } from './staff/staff.controller';
import { PosController } from './pos/pos.controller';
import { PosService } from './pos/pos.service';
import { resolveEnvPath } from './config/resolve-env-path';
import { SuperadminController } from './superadmin/superadmin.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: resolveEnvPath(),
    }),
    JwtModule.register({}),
  ],
  controllers: [
    AuthController,
    StoresController,
    StaffController,
    PosController,
    BackupsController,
    ProductImagesController,
    SuperadminController,
    HealthController,
  ],
  providers: [
    DatabaseService,
    AuthService,
    SessionAuthGuard,
    StoreDataService,
    StoresService,
    PosService,
    BackupsService,
    ProductImagesService,
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: ObjectStorage, useClass: S3ObjectStorage },
  ],
})
export class AppModule {}
