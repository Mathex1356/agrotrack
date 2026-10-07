import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthorizationService } from './authorization.service.js';
import { PermissionGuard } from './permission.guard.js';

@Module({ imports: [PrismaModule], providers: [AuthorizationService, PermissionGuard],
  exports: [AuthorizationService, PermissionGuard] })
export class AuthorizationModule {}
