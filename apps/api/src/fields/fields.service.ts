import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { OrganizationContext } from '../auth/auth.types.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import type { PermissionCode } from '../authorization/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { readFields, writeBoundary } from './field-boundary.js';
import type { FieldCreate, FieldPatch } from './fields.validation.js';

const missing = () => new NotFoundException('Recurso nao encontrado.');
@Injectable()
export class FieldsService {
  constructor(private readonly prisma: PrismaService, private readonly authorization: AuthorizationService) {}

  private async farm(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string, permission: PermissionCode) {
    const scope = await this.authorization.authorizedFarmWhere(context, permission, tx);
    const farm = await tx.farm.findFirst({ where: { AND: [scope, { id: farmId }] }, select: { id: true, status: true, totalAreaHa: true } });
    if (!farm) throw missing();
    return farm;
  }
  private async lockFarm(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string) {
    await this.farm(tx, context, farmId, PERMISSIONS.FIELDS_MANAGE);
    await tx.$queryRaw`SELECT "id" FROM "Farm" WHERE "organizationId" = ${context.organizationId}::uuid AND "id" = ${farmId}::uuid FOR UPDATE`;
    const farm = await this.farm(tx, context, farmId, PERMISSIONS.FIELDS_MANAGE);
    return farm;
  }
  private async write<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(operation); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (['P2002', 'P2034'].includes(error.code)
        || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))))) {
        throw new ConflictException('Conflito ao gravar talhao.');
      }
      throw error;
    }
  }
  private async capacity(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string,
    total: Prisma.Decimal, area: Prisma.Decimal, excludeId?: string) {
    const result = await tx.field.aggregate({ where: { organizationId: context.organizationId, farmId, status: 'ACTIVE',
      ...(excludeId ? { id: { not: excludeId } } : {}) }, _sum: { areaHa: true } });
    if (area.plus(result._sum.areaHa ?? 0).gt(total)) throw new ConflictException('Capacidade da fazenda excedida.');
  }

  async create(context: OrganizationContext, farmId: string, input: FieldCreate) {
    return this.write(async tx => {
      const farm = await this.lockFarm(tx, context, farmId);
      if (farm.status !== 'ACTIVE') throw new ConflictException('Fazenda inativa.');
      await this.capacity(tx, context, farmId, farm.totalAreaHa, input.areaHa);
      const { boundary, ...data } = input;
      const scope = { organizationId: context.organizationId, farmId };
      const field = await tx.field.create({ data: { ...data, ...scope, status: 'ACTIVE' }, select: { id: true } });
      if (boundary !== undefined) await writeBoundary(tx, scope, field.id, boundary);
      return (await readFields(tx, scope, { id: field.id }))[0];
    });
  }
  async list(context: OrganizationContext, farmId: string, page: { limit: number; offset: number }) {
    await this.farm(this.prisma, context, farmId, PERMISSIONS.FARMS_READ);
    const rows = await readFields(this.prisma, { organizationId: context.organizationId, farmId }, page);
    return { items: rows.slice(0, page.limit), ...page, hasMore: rows.length > page.limit };
  }
  async detail(context: OrganizationContext, farmId: string, id: string) {
    await this.farm(this.prisma, context, farmId, PERMISSIONS.FARMS_READ);
    const field = (await readFields(this.prisma, { organizationId: context.organizationId, farmId }, { id }))[0];
    if (!field) throw missing();
    return field;
  }
  async update(context: OrganizationContext, farmId: string, id: string, input: FieldPatch) {
    return this.write(async tx => {
      const farm = await this.lockFarm(tx, context, farmId);
      const scope = { organizationId: context.organizationId, farmId };
      await tx.$queryRaw`SELECT "id" FROM "Field" WHERE "organizationId" = ${scope.organizationId}::uuid AND "farmId" = ${farmId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
      // A concurrent legacy writer may hold Field without the Farm lock.
      await this.farm(tx, context, farmId, PERMISSIONS.FIELDS_MANAGE);
      const current = await tx.field.findFirst({ where: { ...scope, id }, select: { areaHa: true, status: true } });
      if (!current) throw missing();
      if (farm.status !== 'ACTIVE') throw new ConflictException('Fazenda inativa.');
      const area = input.areaHa ?? current.areaHa;
      const status = input.status ?? current.status;
      if (status === 'ACTIVE' && (current.status !== 'ACTIVE' || !area.equals(current.areaHa))) {
        await this.capacity(tx, context, farmId, farm.totalAreaHa, area, id);
      }
      if (area.lt(current.areaHa) && await tx.planting.findFirst({ where: { ...scope, fieldId: id,
        OR: [{ plannedAreaHa: { gt: area } }, { actualAreaHa: { gt: area } }] }, select: { id: true } })) {
        throw new ConflictException('Area incompatível com plantios registrados.');
      }
      if (area.lt(current.areaHa)) {
        const [capacity] = await tx.$queryRaw<{ peak: Prisma.Decimal }[]>`SELECT planting_occupation_peak(${scope.organizationId}::uuid, ${farmId}::uuid, ${id}::uuid) AS peak`;
        if (capacity.peak.gt(area)) throw new ConflictException('Area incompatível com ocupacao temporal registrada.');
      }
      const { boundary, ...data } = input;
      if (Object.keys(data).length) await tx.field.update({ where: { organizationId_farmId_id: { ...scope, id } }, data });
      if (boundary !== undefined) await writeBoundary(tx, scope, id, boundary);
      return (await readFields(tx, scope, { id }))[0];
    });
  }
}
