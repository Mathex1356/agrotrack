import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FieldsController } from './fields.controller.js';
import { FieldsService } from './fields.service.js';

@Module({ imports: [PrismaModule, AuthorizationModule], controllers: [FieldsController], providers: [FieldsService] })
export class FieldsModule {}
