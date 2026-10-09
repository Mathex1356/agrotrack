import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';

export type Boundary = { type: 'MultiPolygon'; coordinates: number[][][][] };
export type FieldCreate = { code: string; name: string; areaHa: Prisma.Decimal;
  soilType?: string | null; description?: string | null; notes?: string | null; boundary?: Boundary | null };
export type FieldPatch = Partial<FieldCreate> & { status?: 'ACTIVE' | 'INACTIVE' };
const invalid = () => new BadRequestException('Entrada invalida.');
const limits = { code: 64, name: 160, soilType: 160, description: 2000, notes: 2000 } as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid();
  return value.trim();
}
export function boundaryInput(value: unknown): Boundary {
  const data = object(value);
  if (Object.keys(data).some(key => !['type', 'coordinates'].includes(key))
    || (data.type !== 'Polygon' && data.type !== 'MultiPolygon') || !Array.isArray(data.coordinates)) throw invalid();
  const polygons: unknown[] = data.type === 'Polygon' ? [data.coordinates] : data.coordinates;
  if (!polygons.length || polygons.length > 16) throw invalid();
  let ringCount = 0, positionCount = 0;
  const coordinates = polygons.map(polygon => {
    if (!Array.isArray(polygon) || !polygon.length) throw invalid();
    return polygon.map(ring => {
      if (++ringCount > 32 || !Array.isArray(ring) || ring.length < 4) throw invalid();
      const positions = ring.map(position => {
        if (++positionCount > 256 || !Array.isArray(position) || position.length !== 2
          || !position.every(value => typeof value === 'number' && Number.isFinite(value))
          || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw invalid();
        return [position[0] as number, position[1] as number];
      });
      if (positions[0][0] !== positions.at(-1)![0] || positions[0][1] !== positions.at(-1)![1]) throw invalid();
      return positions;
    });
  });
  return { type: 'MultiPolygon', coordinates };
}
function parse(body: unknown, patch: boolean): FieldPatch {
  const data = object(body);
  const allowed = [...Object.keys(limits), 'areaHa', 'boundary', ...(patch ? ['status'] : [])];
  if (!Object.keys(data).length || Object.keys(data).some(key => !allowed.includes(key))) throw invalid();
  const result: FieldPatch = {};
  for (const key of ['code', 'name'] as const) {
    if (!patch || Object.hasOwn(data, key)) result[key] = text(data[key], limits[key]);
  }
  if (result.code) result.code = text(result.code.toUpperCase(), limits.code);
  for (const key of ['soilType', 'description', 'notes'] as const) {
    if (Object.hasOwn(data, key)) result[key] = data[key] === null ? null : text(data[key], limits[key]);
  }
  if (!patch || Object.hasOwn(data, 'areaHa')) {
    if (typeof data.areaHa !== 'string' || !/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(data.areaHa)) throw invalid();
    result.areaHa = new Prisma.Decimal(data.areaHa);
    if (result.areaHa.lte(0)) throw invalid();
  }
  if (Object.hasOwn(data, 'boundary')) result.boundary = data.boundary === null ? null : boundaryInput(data.boundary);
  if (Object.hasOwn(data, 'status')) {
    if (data.status !== 'ACTIVE' && data.status !== 'INACTIVE') throw invalid();
    result.status = data.status;
  }
  return result;
}
export const createFieldInput = (body: unknown): FieldCreate => parse(body, false) as FieldCreate;
export const patchFieldInput = (body: unknown): FieldPatch => parse(body, true);
export function fieldRouteId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException('Recurso nao encontrado.');
  return id;
}
export function fieldPage(query: unknown): { limit: number; offset: number } {
  const data = object(query);
  if (Object.keys(data).some(key => !['limit', 'offset'].includes(key))) throw invalid();
  const number = (value: unknown, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,4})$/.test(value)) throw invalid();
    const parsed = Number(value);
    if (parsed < min || parsed > max) throw invalid();
    return parsed;
  };
  return { limit: number(data.limit, 20, 1, 100), offset: number(data.offset, 0, 0, 10000) };
}
export function noFieldQuery(query: unknown): void {
  if (Object.keys(object(query)).length) throw invalid();
}
