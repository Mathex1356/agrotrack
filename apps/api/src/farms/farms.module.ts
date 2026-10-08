import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FarmsController } from './farms.controller.js';
import { FarmsService } from './farms.service.js';

@Module({ imports: [PrismaModule, AuthorizationModule], controllers: [FarmsController], providers: [FarmsService] })
export class FarmsModule {}
