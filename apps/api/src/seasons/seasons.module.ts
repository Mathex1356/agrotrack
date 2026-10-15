import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { SeasonsController } from './seasons.controller.js';
import { SeasonsService } from './seasons.service.js';
@Module({ imports: [PrismaModule, AuthorizationModule], controllers: [SeasonsController], providers: [SeasonsService] })
export class SeasonsModule {}
