import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { FarmsModule } from './farms/farms.module.js';
import { FieldsModule } from './fields/fields.module.js';

@Module({ imports: [PrismaModule, AuthModule, AuthorizationModule, FarmsModule, FieldsModule], controllers: [HealthController] })
export class AppModule {}
