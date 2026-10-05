import type { Request } from 'express';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly sessionId: string;
}
export interface OrganizationContext extends AuthenticatedUser {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly roleId: string;
}
export interface AuthRequest extends Request {
  currentUser?: AuthenticatedUser;
  currentContext?: OrganizationContext;
}
