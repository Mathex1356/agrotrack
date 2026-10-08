import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { OrganizationContext } from '../auth/auth.types.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { validateAreas } from './farms.validation.js';
import type { FarmCreate, FarmPatch } from './farms.validation.js';

const projection = { id: true, code: true, name: true, legalOwnerName: true, locationText: true,
  municipality: true, state: true, country: true, timezone: true, totalAreaHa: true,
  productiveAreaHa: true, description: true, status: true, createdAt: true, updatedAt: true } as const;
const missing = () => new NotFoundException('Fazenda nao encontrada.');

@Injectable()
export class FarmsService {
  constructor(private readonly prisma: PrismaService, private readonly authorization: AuthorizationService) {}

  private async conflicts<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        throw new ConflictException('Conflito ao gravar fazenda.');
      }
      throw error;
    }
  }

  async create(context: OrganizationContext, data: FarmCreate) {
    return this.conflicts(() => this.prisma.$transaction(async tx => {
      await this.authorization.requirePermission(context, PERMISSIONS.FARMS_MANAGE, tx);
      return tx.farm.create({ data: { ...data, organizationId: context.organizationId, status: 'ACTIVE' }, select: projection });
    }));
  }

  async list(context: OrganizationContext, page: { limit: number; offset: number }) {
    const where = await this.authorization.authorizedFarmWhere(context, PERMISSIONS.FARMS_READ);
    const rows = await this.prisma.farm.findMany({ where, select: projection, orderBy: { id: 'asc' },
      take: page.limit + 1, skip: page.offset });
    return { items: rows.slice(0, page.limit), ...page, hasMore: rows.length > page.limit };
  }

  async detail(context: OrganizationContext, id: string) {
    const scope = await this.authorization.authorizedFarmWhere(context, PERMISSIONS.FARMS_READ);
    const farm = await this.prisma.farm.findFirst({ where: { AND: [scope, { id }] }, select: projection });
    if (!farm) throw missing();
    return farm;
  }

  async update(context: OrganizationContext, id: string, data: FarmPatch) {
    return this.conflicts(() => this.prisma.$transaction(async tx => {
      const scope = await this.authorization.authorizedFarmWhere(context, PERMISSIONS.FARMS_MANAGE, tx);
      if (!await tx.farm.findFirst({ where: { AND: [scope, { id }] }, select: { id: true } })) throw missing();
      await tx.$queryRaw`SELECT "id" FROM "Farm" WHERE "organizationId" = ${context.organizationId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
      const refreshed = await this.authorization.authorizedFarmWhere(context, PERMISSIONS.FARMS_MANAGE, tx);
      const current = await tx.farm.findFirst({ where: { AND: [refreshed, { id }] }, select: projection });
      if (!current) throw missing();
      const total = data.totalAreaHa ?? current.totalAreaHa;
      validateAreas(total, data.productiveAreaHa ?? current.productiveAreaHa);
      if (total.lt(current.totalAreaHa)) {
        const fields = await tx.field.aggregate({ where: { organizationId: context.organizationId, farmId: id, status: 'ACTIVE' }, _sum: { areaHa: true } });
        if (fields._sum.areaHa?.gt(total)) throw new ConflictException('Area total incompatível com os talhoes ativos.');
      }
      return tx.farm.update({ where: { organizationId_id: { organizationId: context.organizationId, id } }, data, select: projection });
    }));
  }
}
