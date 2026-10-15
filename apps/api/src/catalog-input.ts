import { BadRequestException, NotFoundException } from '@nestjs/common';

const invalid = () => new BadRequestException('Entrada invalida.');
export function bodyObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;
  if (!Object.keys(data).length || Object.keys(data).some(key => !allowed.includes(key))) throw invalid();
  return data;
}
export function resourceText(value: unknown, max: number, uppercase = false): string {
  if (typeof value !== 'string') throw invalid();
  const normalized = uppercase ? value.trim().toUpperCase() : value.trim();
  if (!normalized || value.length > max || normalized.length > max
    || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw invalid();
  return normalized;
}
export function resourceId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new NotFoundException('Recurso nao encontrado.');
  return value;
}
export function resourcePage(value: unknown): { limit: number; offset: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['limit', 'offset'].includes(key))) throw invalid();
  const number = (value: unknown, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,4})$/.test(value)) throw invalid();
    const result = Number(value);
    if (result < min || result > max) throw invalid();
    return result;
  };
  return { limit: number(data.limit, 20, 1, 100), offset: number(data.offset, 0, 0, 10000) };
}
export function noResourceQuery(value: unknown): void {
  resourcePage(value);
  if (Object.keys(value as object).length) throw invalid();
}
export function civilDate(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) throw invalid();
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid();
  return date;
}
