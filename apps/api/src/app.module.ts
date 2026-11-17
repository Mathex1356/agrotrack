import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { FarmsModule } from './farms/farms.module.js';
import { FieldsModule } from './fields/fields.module.js';
import { CropsModule } from './crops/crops.module.js';
import { PlantingsModule } from './plantings/plantings.module.js';
import { SeasonsModule } from './seasons/seasons.module.js';

@Module({ imports: [PrismaModule, AuthModule, AuthorizationModule, FarmsModule, FieldsModule, CropsModule, SeasonsModule, PlantingsModule], controllers: [HealthController] })
export class AppModule {}

