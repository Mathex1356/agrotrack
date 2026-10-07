import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthRequest } from '../auth/auth.types.js';
import { AuthorizationService } from './authorization.service.js';
import { isPermissionCode } from './permissions.js';
import { REQUIRED_PERMISSIONS } from './authorization.decorators.js';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly authorization: AuthorizationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (!request.currentUser) throw new UnauthorizedException();
    if (!request.currentContext) throw new ForbiddenException('Acesso negado.');
    const declarations = [context.getClass(), context.getHandler()]
      .map(target => this.reflector.get<unknown>(REQUIRED_PERMISSIONS, target))
      .filter(value => value !== undefined);
    if (!declarations.length || declarations.some(value => !Array.isArray(value))) throw new ForbiddenException('Acesso negado.');
    const groups: unknown[] = declarations.flat();
    if (!groups.length || groups.some(group => !Array.isArray(group) || !group.length || !group.every(isPermissionCode))) {
      throw new ForbiddenException('Acesso negado.');
    }
    await this.authorization.requirePermissions(request.currentContext, groups.flat().filter(isPermissionCode));
    return true;
  }
}
