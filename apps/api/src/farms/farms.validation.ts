import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';

const invalid = () => new BadRequestException('Entrada invalida.');
const requiredText = { code: 64, name: 160, municipality: 160, state: 80, country: 2, timezone: 100 } as const;
const optionalText = { legalOwnerName: 200, locationText: 500, description: 2000 } as const;
type RequiredText = { -readonly [K in keyof typeof requiredText]: string };
type OptionalText = { -readonly [K in keyof typeof optionalText]?: string | null };
export type FarmCreate = RequiredText & OptionalText & { totalAreaHa: Prisma.Decimal; productiveAreaHa: Prisma.Decimal };
export type FarmPatch = Partial<FarmCreate> & { status?: 'ACTIVE' | 'INACTIVE' };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw invalid();
  return value.trim();
}
function area(value: unknown): Prisma.Decimal {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value)) throw invalid();
  return new Prisma.Decimal(value);
}
export function validateAreas(total: Prisma.Decimal, productive: Prisma.Decimal): void {
  if (total.lte(0) || productive.lt(0) || productive.gt(total)) throw invalid();
}
function parse(body: unknown, patch: boolean): FarmPatch {
  const data = object(body);
  const allowed = [...Object.keys(requiredText), ...Object.keys(optionalText), 'totalAreaHa', 'productiveAreaHa', ...(patch ? ['status'] : [])];
  if (!Object.keys(data).length || Object.keys(data).some(key => !allowed.includes(key))) throw invalid();
  const result: FarmPatch = {};
  for (const key of Object.keys(requiredText) as (keyof RequiredText)[]) {
    if (!patch || Object.hasOwn(data, key)) result[key] = text(data[key], requiredText[key]);
  }
  for (const key of Object.keys(optionalText) as (keyof OptionalText)[]) {
    if (Object.hasOwn(data, key)) result[key] = data[key] === null ? null : text(data[key], optionalText[key]);
  }
  for (const key of ['totalAreaHa', 'productiveAreaHa'] as const) {
    if (!patch || Object.hasOwn(data, key)) result[key] = area(data[key]);
  }
  if (result.code) result.code = text(result.code.toUpperCase(), requiredText.code);
  if (result.country) {
    if (!/^[a-z]{2}$/i.test(result.country)) throw invalid();
    result.country = result.country.toUpperCase();
  }
  if (result.timezone) {
    if (/^[+-]/.test(result.timezone)) throw invalid();
    try { new Intl.DateTimeFormat('en', { timeZone: result.timezone }).format(); }
    catch { throw invalid(); }
  }
  if (Object.hasOwn(data, 'status')) {
    if (data.status !== 'ACTIVE' && data.status !== 'INACTIVE') throw invalid();
    result.status = data.status;
  }
  if (result.totalAreaHa?.lte(0) || result.productiveAreaHa?.lt(0)) throw invalid();
  return result;
}
export function createFarmInput(body: unknown): FarmCreate {
  const data = parse(body, false) as FarmCreate;
  validateAreas(data.totalAreaHa, data.productiveAreaHa);
  return data;
}
export const patchFarmInput = (body: unknown): FarmPatch => parse(body, true);
export function farmId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new NotFoundException('Fazenda nao encontrada.');
  return value;
}
export function farmPage(query: unknown): { limit: number; offset: number } {
  const data = object(query);
  if (Object.keys(data).some(key => !['limit', 'offset'].includes(key))) throw invalid();
  const integer = (value: unknown, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,4})$/.test(value)) throw invalid();
    const parsed = Number(value);
    if (parsed < min || parsed > max) throw invalid();
    return parsed;
  };
  return { limit: integer(data.limit, 20, 1, 100), offset: integer(data.offset, 0, 0, 10000) };
}
export function noFarmQuery(query: unknown): void {
  if (Object.keys(object(query)).length) throw invalid();
}
