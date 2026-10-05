import { createParamDecorator, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthRequest } from './auth.types.js';

export const PUBLIC_ROUTE = 'agrotrack.public';
export const CONTEXT_ROUTE = 'agrotrack.context';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const RequireOrganization = () => SetMetadata(CONTEXT_ROUTE, true);
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<AuthRequest>().currentUser;
  if (!value) throw new UnauthorizedException();
  return value;
});
export const CurrentContext = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<AuthRequest>().currentContext;
  if (!value) throw new UnauthorizedException();
  return value;
});
