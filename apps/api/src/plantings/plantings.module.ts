import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { PlantingsController } from './plantings.controller.js';
import { PlantingsService } from './plantings.service.js';
@Module({ imports: [PrismaModule, AuthorizationModule], controllers: [PlantingsController], providers: [PlantingsService] })
export class PlantingsModule {}

