import { BadRequestException } from '@nestjs/common';
import { bodyObject, resourceText } from '../catalog-input.js';

export type CropCreate = { code: string; name: string };
export type CropPatch = Partial<CropCreate> & { status?: 'ACTIVE' | 'INACTIVE' };
function parse(body: unknown, patch: boolean): CropPatch {
  const data = bodyObject(body, ['code', 'name', ...(patch ? ['status'] : [])]);
  const result: CropPatch = {};
  if (!patch || Object.hasOwn(data, 'code')) result.code = resourceText(data.code, 64, true);
  if (!patch || Object.hasOwn(data, 'name')) result.name = resourceText(data.name, 160);
  if (Object.hasOwn(data, 'status')) {
    if (data.status !== 'ACTIVE' && data.status !== 'INACTIVE') throw new BadRequestException('Entrada invalida.');
    result.status = data.status;
  }
  return result;
}
export const createCropInput = (body: unknown): CropCreate => parse(body, false) as CropCreate;
export const patchCropInput = (body: unknown): CropPatch => parse(body, true);
