import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { PUBLIC_ROUTE, CONTEXT_ROUTE } from './auth.decorators.js';
import type { AuthRequest } from './auth.types.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const header = request.headers.authorization;
    if (!header || header.length > 4096 || !/^Bearer [A-Za-z0-9_.-]+$/.test(header)) throw new UnauthorizedException();
    request.currentUser = await this.auth.authenticate(header.slice(7));
    if (this.reflector.getAllAndOverride<boolean>(CONTEXT_ROUTE, [context.getHandler(), context.getClass()])) {
      const selected = request.headers['x-organization-membership-id'];
      request.currentContext = await this.auth.context(request.currentUser, typeof selected === 'string' ? selected : '');
    }
    return true;
  }
}
