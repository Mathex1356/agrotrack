import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { OrganizationContext } from '../auth/auth.types.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PERMISSIONS, type PermissionCode } from '../authorization/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { plantingDates, type PlantingCreate, type PlantingPatch, type PlantingPage } from './plantings.validation.js';

const select = { id: true, farmId: true, fieldId: true, seasonId: true, cropId: true, variety: true, plannedAreaHa: true,
  actualAreaHa: true, plannedStartDate: true, expectedEndDate: true, actualStartDate: true, actualEndDate: true,
  spacingMeters: true, populationPerHa: true, notes: true, status: true, createdAt: true, updatedAt: true } as const;
type Row = Prisma.PlantingGetPayload<{ select: typeof select }>;
const dto = (row: Row) => ({ ...row, plannedAreaHa: row.plannedAreaHa.toString(), actualAreaHa: row.actualAreaHa?.toString() ?? null,
  spacingMeters: row.spacingMeters?.toString() ?? null, populationPerHa: row.populationPerHa?.toString() ?? null,
  plannedStartDate: row.plannedStartDate.toISOString().slice(0, 10), expectedEndDate: row.expectedEndDate?.toISOString().slice(0, 10) ?? null,
  actualStartDate: row.actualStartDate?.toISOString().slice(0, 10) ?? null, actualEndDate: row.actualEndDate?.toISOString().slice(0, 10) ?? null });
const missing = () => new NotFoundException('Recurso nao encontrado.');
@Injectable()
export class PlantingsService {
  constructor(private readonly prisma: PrismaService, private readonly authorization: AuthorizationService) {}
  private async farm(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string, permission: PermissionCode) {
    const scope = await this.authorization.authorizedFarmWhere(context, permission, tx);
    const row = await tx.farm.findFirst({ where: { AND: [scope, { id: farmId }] }, select: { id: true, status: true } });
    if (!row) throw missing(); return row;
  }
  private async lockFarm(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string) {
    await this.farm(tx, context, farmId, PERMISSIONS.PLANTINGS_MANAGE);
    await tx.$queryRaw`SELECT "id" FROM "Farm" WHERE "organizationId"=${context.organizationId}::uuid AND "id"=${farmId}::uuid FOR UPDATE`;
  }
  private async parents(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string, references: { fieldId: string; seasonId: string; cropId: string }) {
    const scope = { organizationId: context.organizationId, farmId };
    await tx.$queryRaw`SELECT "id" FROM "Season" WHERE "organizationId"=${context.organizationId}::uuid AND "farmId"=${farmId}::uuid AND "id"=${references.seasonId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "Crop" WHERE "id"=${references.cropId}::uuid AND ("scope"='GLOBAL' OR "organizationId"=${context.organizationId}::uuid) FOR SHARE`;
    const field = await tx.field.findFirst({ where: { ...scope, id: references.fieldId }, select: { areaHa: true, status: true } });
    const season = await tx.season.findFirst({ where: { ...scope, id: references.seasonId }, select: { status: true } });
    const crop = await tx.crop.findFirst({ where: { id: references.cropId, OR: [{ scope: 'GLOBAL' }, { organizationId: context.organizationId, scope: 'ORGANIZATION' }] }, select: { status: true } });
    if (!field || !season || !crop) throw missing();
    const farm = await this.farm(tx, context, farmId, PERMISSIONS.PLANTINGS_MANAGE);
    if (farm.status !== 'ACTIVE' || field.status !== 'ACTIVE' || crop.status !== 'ACTIVE' || !['PLANNED', 'IN_PROGRESS'].includes(season.status)) {
      throw new ConflictException('Estado incompatível com planejamento.');
    }
    return field;
  }
  private async lockField(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string, fieldId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Field" WHERE "organizationId"=${context.organizationId}::uuid AND "farmId"=${farmId}::uuid AND "id"=${fieldId}::uuid FOR UPDATE`;
  }
  private async write<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(operation); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (['P2002', 'P2034'].includes(error.code)
        || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))))) throw new ConflictException('Conflito ao gravar plantio.');
      throw error;
    }
  }
  async create(context: OrganizationContext, farmId: string, data: PlantingCreate) {
    return this.write(async tx => {
      await this.lockFarm(tx, context, farmId);
      await this.lockField(tx, context, farmId, data.fieldId);
      const field = await this.parents(tx, context, farmId, data);
      if (data.plannedAreaHa.gt(field.areaHa)) throw new ConflictException('Area incompatível com talhao.');
      return dto(await tx.planting.create({ data: { ...data, organizationId: context.organizationId, farmId, status: 'PLANNED' }, select }));
    });
  }
  async list(context: OrganizationContext, farmId: string, page: PlantingPage) {
    await this.farm(this.prisma, context, farmId, PERMISSIONS.FARMS_READ);
    const { limit, offset, ...filters } = page;
    const rows = await this.prisma.planting.findMany({ where: { organizationId: context.organizationId, farmId, ...filters }, select,
      orderBy: { id: 'asc' }, skip: offset, take: limit + 1 });
    return { items: rows.slice(0, limit).map(dto), limit, offset, hasMore: rows.length > limit };
  }
  async detail(context: OrganizationContext, farmId: string, id: string) {
    await this.farm(this.prisma, context, farmId, PERMISSIONS.FARMS_READ);
    const row = await this.prisma.planting.findFirst({ where: { organizationId: context.organizationId, farmId, id }, select });
    if (!row) throw missing(); return dto(row);
  }
  async update(context: OrganizationContext, farmId: string, id: string, data: PlantingPatch) {
    return this.write(async tx => {
      await this.lockFarm(tx, context, farmId);
      const scope = { organizationId: context.organizationId, farmId, id };
      const reference = await tx.planting.findFirst({ where: scope, select: { fieldId: true } });
      if (!reference) throw missing();
      await this.lockField(tx, context, farmId, reference.fieldId);
      await tx.$queryRaw`SELECT "id" FROM "Planting" WHERE "organizationId"=${context.organizationId}::uuid AND "farmId"=${farmId}::uuid AND "id"=${id}::uuid FOR UPDATE`;
      const current = await tx.planting.findFirst({ where: scope, select });
      if (!current) throw missing();
      // A direct writer may have moved the relationship before this lock; never use a stale Field lock.
      if (current.fieldId !== reference.fieldId || current.status !== 'PLANNED') throw new ConflictException('Estado incompatível com planejamento.');
      const field = await this.parents(tx, context, farmId, current);
      if ((data.plannedAreaHa ?? current.plannedAreaHa).gt(field.areaHa)) throw new ConflictException('Area incompatível com talhao.');
      plantingDates(data.plannedStartDate ?? current.plannedStartDate, data.expectedEndDate === undefined ? current.expectedEndDate : data.expectedEndDate);
      return dto(await tx.planting.update({ where: scope, data, select }));
    });
  }
}
