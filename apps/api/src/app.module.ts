import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthRateLimitService } from './auth/auth-rate-limit.service';
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
import { ActivityController } from './activity/activity.controller';
import { ActivityService } from './activity/activity.service';
import { PaymentSettingsController } from './payment-settings/payment-settings.controller';
import { PaymentSettingsService } from './payment-settings/payment-settings.service';
import { BackupSchedulerService } from './backups/backup-scheduler.service';
import { ObjectOperationsService } from './storage/object-operations.service';
import { RetentionService } from './operations/retention.service';
import { BackupRestoreService } from './backups/backup-restore.service';
import { MetricsController } from './operations/metrics.controller';

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
    ActivityController,
    PaymentSettingsController,
    HealthController,
    MetricsController,
  ],
  providers: [
    DatabaseService,
    AuthService,
    AuthRateLimitService,
    SessionAuthGuard,
    StoreDataService,
    StoresService,
    PosService,
    BackupsService,
    ProductImagesService,
    ActivityService,
    PaymentSettingsService,
    BackupSchedulerService,
    ObjectOperationsService,
    RetentionService,
    BackupRestoreService,
    { provide: ObjectStorage, useClass: S3ObjectStorage },
  ],
})
export class AppModule {}
