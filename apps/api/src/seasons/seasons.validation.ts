import { BadRequestException } from '@nestjs/common';
import { bodyObject, civilDate, resourceText } from '../catalog-input.js';
export type SeasonCreate = { code: string; name: string; startDate: Date; expectedEndDate: Date };
export type SeasonPatch = Partial<SeasonCreate>;
export function seasonDates(start: Date, end: Date): void {
  if (end < start) throw new BadRequestException('Entrada invalida.');
}
function parse(body: unknown, patch: boolean): SeasonPatch {
  const data = bodyObject(body, ['code', 'name', 'startDate', 'expectedEndDate']);
  const result: SeasonPatch = {};
  if (!patch || Object.hasOwn(data, 'code')) result.code = resourceText(data.code, 64, true);
  if (!patch || Object.hasOwn(data, 'name')) result.name = resourceText(data.name, 160);
  for (const key of ['startDate', 'expectedEndDate'] as const) if (!patch || Object.hasOwn(data, key)) result[key] = civilDate(data[key]);
  if (result.startDate && result.expectedEndDate) seasonDates(result.startDate, result.expectedEndDate);
  return result;
}
export const createSeasonInput = (body: unknown): SeasonCreate => parse(body, false) as SeasonCreate;
export const patchSeasonInput = (body: unknown): SeasonPatch => parse(body, true);
