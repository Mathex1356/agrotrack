import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CropsController } from './crops.controller.js';
import { CropsService } from './crops.service.js';
@Module({ imports: [PrismaModule, AuthorizationModule], controllers: [CropsController], providers: [CropsService] })
export class CropsModule {}
