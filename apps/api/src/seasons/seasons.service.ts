import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { OrganizationContext } from '../auth/auth.types.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import type { PermissionCode } from '../authorization/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { seasonDates } from './seasons.validation.js';
import type { SeasonCreate, SeasonPatch } from './seasons.validation.js';
const select = { id: true, farmId: true, code: true, name: true, startDate: true, expectedEndDate: true,
  actualEndDate: true, status: true, createdAt: true, updatedAt: true } as const;
type Row = Prisma.SeasonGetPayload<{ select: typeof select }>;
const dto = (row: Row) => ({ ...row, startDate: row.startDate.toISOString().slice(0, 10),
  expectedEndDate: row.expectedEndDate.toISOString().slice(0, 10), actualEndDate: row.actualEndDate?.toISOString().slice(0, 10) ?? null });
const missing = () => new NotFoundException('Recurso nao encontrado.');
@Injectable()
export class SeasonsService {
  constructor(private readonly prisma: PrismaService, private readonly authorization: AuthorizationService) {}
  private async farm(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string, permission: PermissionCode) {
    const scope = await this.authorization.authorizedFarmWhere(context, permission, tx);
    const row = await tx.farm.findFirst({ where: { AND: [scope, { id: farmId }] }, select: { id: true, status: true } });
    if (!row) throw missing(); return row;
  }
  private async lockFarm(tx: Prisma.TransactionClient, context: OrganizationContext, farmId: string) {
    await this.farm(tx, context, farmId, PERMISSIONS.SEASONS_MANAGE);
    await tx.$queryRaw`SELECT "id" FROM "Farm" WHERE "organizationId"=${context.organizationId}::uuid AND "id"=${farmId}::uuid FOR UPDATE`;
    return this.farm(tx, context, farmId, PERMISSIONS.SEASONS_MANAGE);
  }
  private async write<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(operation); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) throw new ConflictException('Conflito ao gravar safra.');
      throw error;
    }
  }
  async create(context: OrganizationContext, farmId: string, data: SeasonCreate) {
    return this.write(async tx => {
      const farm = await this.lockFarm(tx, context, farmId);
      if (farm.status !== 'ACTIVE') throw new ConflictException('Fazenda inativa.');
      return dto(await tx.season.create({ data: { ...data, organizationId: context.organizationId, farmId, status: 'PLANNED' }, select }));
    });
  }
  async list(context: OrganizationContext, farmId: string, page: { limit: number; offset: number }) {
    await this.farm(this.prisma, context, farmId, PERMISSIONS.FARMS_READ);
    const rows = await this.prisma.season.findMany({ where: { organizationId: context.organizationId, farmId }, select,
      orderBy: { id: 'asc' }, skip: page.offset, take: page.limit + 1 });
    return { items: rows.slice(0, page.limit).map(dto), ...page, hasMore: rows.length > page.limit };
  }
  async detail(context: OrganizationContext, farmId: string, id: string) {
    await this.farm(this.prisma, context, farmId, PERMISSIONS.FARMS_READ);
    const row = await this.prisma.season.findFirst({ where: { organizationId: context.organizationId, farmId, id }, select });
    if (!row) throw missing(); return dto(row);
  }
  async update(context: OrganizationContext, farmId: string, id: string, data: SeasonPatch) {
    return this.write(async tx => {
      const farm = await this.lockFarm(tx, context, farmId);
      const scope = { organizationId: context.organizationId, farmId, id };
      await tx.$queryRaw`SELECT "id" FROM "Season" WHERE "organizationId"=${context.organizationId}::uuid AND "farmId"=${farmId}::uuid AND "id"=${id}::uuid FOR UPDATE`;
      await this.farm(tx, context, farmId, PERMISSIONS.SEASONS_MANAGE);
      const current = await tx.season.findFirst({ where: scope, select });
      if (!current) throw missing();
      if (farm.status !== 'ACTIVE' || current.status !== 'PLANNED') throw new ConflictException('Estado incompatível com edicao cadastral.');
      seasonDates(data.startDate ?? current.startDate, data.expectedEndDate ?? current.expectedEndDate);
      if (current.actualEndDate) seasonDates(data.startDate ?? current.startDate, current.actualEndDate);
      return dto(await tx.season.update({ where: { organizationId_farmId_id: scope }, data, select }));
    });
  }
}
