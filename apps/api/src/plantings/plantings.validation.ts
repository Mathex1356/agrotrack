import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { bodyObject, civilDate, resourcePage, resourceText } from '../catalog-input.js';

export type PlantingPatch = {
  plannedAreaHa?: Prisma.Decimal; plannedStartDate?: Date; expectedEndDate?: Date | null;
  variety?: string | null; spacingMeters?: Prisma.Decimal | null; populationPerHa?: Prisma.Decimal | null; notes?: string | null;
};
export type PlantingCreate = PlantingPatch & { fieldId: string; seasonId: string; cropId: string; plannedAreaHa: Prisma.Decimal; plannedStartDate: Date };
export type PlantingPage = { limit: number; offset: number; fieldId?: string; seasonId?: string; cropId?: string; status?: 'PLANNED' | 'IN_PROGRESS' | 'FINISHED' | 'CANCELLED' };
const invalid = () => new BadRequestException('Entrada invalida.');
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid();
  return value;
}
function decimal(value: unknown, integerDigits: number): Prisma.Decimal {
  if (typeof value !== 'string' || !new RegExp(`^(0|[1-9]\\d{0,${integerDigits - 1}})(\\.\\d{1,6})?$`).test(value)) throw invalid();
  const result = new Prisma.Decimal(value);
  if (result.lte(0)) throw invalid();
  return result;
}
export function plantingDates(start: Date, end: Date | null | undefined): void {
  if (end && end < start) throw invalid();
}
function parse(body: unknown, patch: boolean): PlantingPatch | PlantingCreate {
  const data = bodyObject(body, ['plannedAreaHa', 'plannedStartDate', 'expectedEndDate', 'variety', 'spacingMeters', 'populationPerHa', 'notes',
    ...(!patch ? ['fieldId', 'seasonId', 'cropId'] : [])]);
  const result: PlantingPatch = {};
  if (!patch || Object.hasOwn(data, 'plannedAreaHa')) result.plannedAreaHa = decimal(data.plannedAreaHa, 12);
  if (!patch || Object.hasOwn(data, 'plannedStartDate')) result.plannedStartDate = civilDate(data.plannedStartDate);
  if (Object.hasOwn(data, 'expectedEndDate')) result.expectedEndDate = data.expectedEndDate === null ? null : civilDate(data.expectedEndDate);
  for (const key of ['variety', 'notes'] as const) if (Object.hasOwn(data, key)) result[key] = data[key] === null ? null : resourceText(data[key], key === 'variety' ? 160 : 2000);
  for (const key of ['spacingMeters', 'populationPerHa'] as const) if (Object.hasOwn(data, key)) result[key] = data[key] === null ? null : decimal(data[key], key === 'populationPerHa' ? 14 : 12);
  if (result.plannedStartDate) plantingDates(result.plannedStartDate, result.expectedEndDate);
  if (!patch) return { ...result, fieldId: uuid(data.fieldId), seasonId: uuid(data.seasonId), cropId: uuid(data.cropId) } as PlantingCreate;
  return result;
}
export const createPlantingInput = (body: unknown): PlantingCreate => parse(body, false) as PlantingCreate;
export const patchPlantingInput = (body: unknown): PlantingPatch => parse(body, true);
export function plantingPage(query: unknown): PlantingPage {
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw invalid();
  const data = query as Record<string, unknown>;
  if (Object.keys(data).some(key => !['limit', 'offset', 'fieldId', 'seasonId', 'cropId', 'status'].includes(key))) throw invalid();
  const result: PlantingPage = resourcePage({ limit: data.limit, offset: data.offset });
  for (const key of ['fieldId', 'seasonId', 'cropId'] as const) if (Object.hasOwn(data, key)) result[key] = uuid(data[key]);
  if (Object.hasOwn(data, 'status')) {
    if (!['PLANNED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED'].includes(data.status as string)) throw invalid();
    result.status = data.status as PlantingPage['status'];
  }
  return result;
}
