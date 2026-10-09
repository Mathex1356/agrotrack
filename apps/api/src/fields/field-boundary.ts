import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { Boundary } from './fields.validation.js';

type Scope = { organizationId: string; farmId: string };
type Row = { id: string; farmId: string; code: string; name: string; areaHa: string;
  status: string; geometryRevision: number; createdAt: Date; updatedAt: Date;
  soilType?: string | null; description?: string | null; notes?: string | null;
  boundary?: Boundary | null; mapped: boolean; calculated: string | null; transportable?: boolean };

// Only internal SQL expressions enter this helper, never caller-supplied identifiers.
function transportable(geometry: Prisma.Sql): Prisma.Sql {
  const imported = Prisma.sql`ST_GeomFromGeoJSON(ST_AsGeoJSON(${geometry}, 17, 0))`;
  return Prisma.sql`CASE WHEN ${geometry} IS NULL THEN true
    WHEN ST_IsValid(${geometry}, 0) AND ST_IsValid(${imported}, 0)
      THEN ST_Equals(${geometry}, ${imported}) ELSE false END`;
}

export async function writeBoundary(tx: Prisma.TransactionClient, scope: Scope, id: string, boundary: Boundary | null): Promise<void> {
  if (boundary === null) {
    await tx.$executeRaw`UPDATE "Field" SET "boundary" = NULL WHERE "organizationId" = ${scope.organizationId}::uuid AND "farmId" = ${scope.farmId}::uuid AND "id" = ${id}::uuid`;
    return;
  }
  // Strict transport validation precedes PostGIS topology validation. Never repair.
  const updated = await tx.$executeRaw`UPDATE "Field" f SET "boundary" = shape.geometry
    FROM (SELECT ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(boundary)}), 4326)) AS geometry) shape
    WHERE f."organizationId" = ${scope.organizationId}::uuid AND f."farmId" = ${scope.farmId}::uuid AND f."id" = ${id}::uuid
      AND ST_IsValid(shape.geometry, 0) AND NOT ST_IsEmpty(shape.geometry)
      AND ${transportable(Prisma.sql`shape.geometry`)}`;
  if (updated !== 1) throw new BadRequestException('Geometria invalida.');
}

// One SQL projection keeps metadata, geometry/revision and derived area consistent.
export async function readFields(tx: Prisma.TransactionClient, scope: Scope,
  selection: { id: string } | { limit: number; offset: number }) {
  const full = 'id' in selection;
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT "id", "farmId", "code", "name", "areaHa"::text AS "areaHa", "status", "geometryRevision", "createdAt", "updatedAt",
      ${full ? Prisma.sql`"soilType", "description", "notes", ST_AsGeoJSON("boundary", 17, 0)::json AS "boundary",
        ${transportable(Prisma.sql`"boundary"`)} AS "transportable",` : Prisma.empty}
      ("boundary" IS NOT NULL) AS "mapped", (ST_Area("boundary"::geography) / 10000)::text AS "calculated"
    FROM "Field" WHERE "organizationId" = ${scope.organizationId}::uuid AND "farmId" = ${scope.farmId}::uuid
      ${full ? Prisma.sql`AND "id" = ${selection.id}::uuid` : Prisma.empty}
    ORDER BY "id" ASC ${full ? Prisma.sql`LIMIT 1` : Prisma.sql`LIMIT ${selection.limit + 1} OFFSET ${selection.offset}`}`);
  return rows.map(({ calculated, transportable: canTransport, ...row }) => {
    if (canTransport === false) throw new ConflictException('Geometria armazenada exige revisao para transporte.');
    const area = calculated === null ? null : new Prisma.Decimal(calculated);
    const difference = area === null ? null : area.minus(row.areaHa).abs().div(row.areaHa).times(100);
    return { ...row, areaHa: new Prisma.Decimal(row.areaHa).toString(),
      calculatedAreaHa: area?.toFixed(6, Prisma.Decimal.ROUND_HALF_UP) ?? null,
      areaDifferencePercent: difference?.toFixed(6, Prisma.Decimal.ROUND_HALF_UP) ?? null,
      areaNeedsReview: difference?.gt(2) ?? false };
  });
}
