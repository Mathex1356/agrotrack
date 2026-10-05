import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthConfig } from './auth.config.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { PasswordService } from './password.service.js';
import { RateLimitService } from './rate-limit.service.js';

@Module({ imports: [PrismaModule], controllers: [AuthController], providers: [AuthConfig, AuthService,
  PasswordService, RateLimitService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthConfig] })
export class AuthModule {}
