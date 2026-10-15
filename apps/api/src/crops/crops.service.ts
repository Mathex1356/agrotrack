import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { OrganizationContext } from '../auth/auth.types.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CropCreate, CropPatch } from './crops.validation.js';

const select = { id: true, scope: true, code: true, name: true, status: true, createdAt: true, updatedAt: true } as const;
const missing = () => new NotFoundException('Recurso nao encontrado.');
@Injectable()
export class CropsService {
  constructor(private readonly prisma: PrismaService, private readonly authorization: AuthorizationService) {}
  private visible(context: OrganizationContext): Prisma.CropWhereInput {
    return { OR: [{ scope: 'GLOBAL', organizationId: null }, { scope: 'ORGANIZATION', organizationId: context.organizationId }] };
  }
  private async write<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(operation); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) throw new ConflictException('Conflito ao gravar cultura.');
      throw error;
    }
  }
  async create(context: OrganizationContext, data: CropCreate) {
    return this.write(async tx => {
      await this.authorization.requirePermission(context, PERMISSIONS.CROPS_MANAGE, tx);
      return tx.crop.create({ data: { ...data, organizationId: context.organizationId, scope: 'ORGANIZATION', status: 'ACTIVE' }, select });
    });
  }
  async list(context: OrganizationContext, page: { limit: number; offset: number }) {
    await this.authorization.requirePermission(context, PERMISSIONS.CROPS_READ);
    const rows = await this.prisma.crop.findMany({ where: this.visible(context), select, orderBy: { id: 'asc' }, skip: page.offset, take: page.limit + 1 });
    return { items: rows.slice(0, page.limit), ...page, hasMore: rows.length > page.limit };
  }
  async detail(context: OrganizationContext, id: string) {
    await this.authorization.requirePermission(context, PERMISSIONS.CROPS_READ);
    const result = await this.prisma.crop.findFirst({ where: { AND: [this.visible(context), { id }] }, select });
    if (!result) throw missing();
    return result;
  }
  async update(context: OrganizationContext, id: string, data: CropPatch) {
    return this.write(async tx => {
      await this.authorization.requirePermission(context, PERMISSIONS.CROPS_MANAGE, tx);
      const where = { id, organizationId: context.organizationId, scope: 'ORGANIZATION' as const };
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Crop" WHERE "id"=${id}::uuid
        AND "organizationId"=${context.organizationId}::uuid AND "scope"='ORGANIZATION' FOR UPDATE`;
      await this.authorization.requirePermission(context, PERMISSIONS.CROPS_MANAGE, tx);
      if (!locked.length || !await tx.crop.findFirst({ where, select: { id: true } })) throw missing();
      return tx.crop.update({ where, data, select });
    });
  }
}
