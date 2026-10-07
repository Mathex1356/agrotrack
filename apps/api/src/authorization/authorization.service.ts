import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { OrganizationContext } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isPermissionCode } from './permissions.js';
import type { PermissionCode } from './permissions.js';

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const denied = () => new ForbiddenException('Acesso negado.');

@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolve(context: OrganizationContext | undefined, codes: readonly PermissionCode[]) {
    if (!context || !uuid(context.userId) || !uuid(context.sessionId)) throw new UnauthorizedException();
    const session = await this.prisma.authSession.findFirst({ where: {
      id: context.sessionId, userId: context.userId, revokedAt: null,
      expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' },
    }, select: { id: true } });
    if (!session) throw new UnauthorizedException();
    if (![context.membershipId, context.organizationId, context.roleId].every(uuid)) throw denied();
    const member = await this.prisma.organizationMembership.findFirst({ where: {
      id: context.membershipId, userId: context.userId, organizationId: context.organizationId,
      roleId: context.roleId, status: 'ACTIVE', organization: { status: 'ACTIVE' },
      role: { status: 'ACTIVE', organizationId: context.organizationId },
    }, select: { role: { select: { systemCode: true, permissions: {
      where: { organizationId: context.organizationId, permissionCode: { in: [...codes] }, permission: { status: 'ACTIVE' } },
      select: { permissionCode: true },
    } } } } });
    if (!member) throw denied();
    const granted = new Set(member.role.permissions.map(value => value.permissionCode));
    if (codes.some(code => !granted.has(code))) throw denied();
    return { context, owner: member.role.systemCode === 'OWNER' };
  }

  private codes(codes: readonly PermissionCode[]): readonly PermissionCode[] {
    if (!Array.isArray(codes) || codes.length === 0 || !codes.every(isPermissionCode)) throw denied();
    return [...new Set(codes)];
  }

  async requirePermission(context: OrganizationContext, code: PermissionCode): Promise<void> {
    await this.requirePermissions(context, [code]);
  }

  async requirePermissions(context: OrganizationContext, codes: readonly PermissionCode[]): Promise<void> {
    await this.resolve(context, this.codes(codes));
  }

  private async territory(context: OrganizationContext, owner: boolean, farmId: string): Promise<void> {
    if (!uuid(farmId)) throw denied();
    const farm = await this.prisma.farm.findFirst({ where: {
      id: farmId, organizationId: context.organizationId,
      ...(owner ? {} : { memberships: { some: {
        organizationId: context.organizationId, organizationMembershipId: context.membershipId, status: 'ACTIVE',
      } } }),
    }, select: { id: true } });
    if (!farm) throw denied();
  }

  // Territory only: callers still need the capability and operation-specific predicates.
  async requireFarmAccess(context: OrganizationContext, farmId: string): Promise<void> {
    const resolved = await this.resolve(context, []);
    await this.territory(resolved.context, resolved.owner, farmId);
  }

  async requireFarmPermission(context: OrganizationContext, farmId: string, code: PermissionCode): Promise<void> {
    const resolved = await this.resolve(context, this.codes([code]));
    await this.territory(resolved.context, resolved.owner, farmId);
  }
}
