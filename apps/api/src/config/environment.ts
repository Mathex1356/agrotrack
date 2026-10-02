import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

export class ConfigurationError extends Error {}

export function loadEnvironment(): void {
  const envPath = resolve(import.meta.dirname, '../../../../.env');
  if (existsSync(envPath)) loadEnvFile(envPath);
}

export function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new ConfigurationError('DATABASE_URL é obrigatória. Configure o .env na raiz.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError('DATABASE_URL inválida. Revise a configuração local.');
  }
  if (
    !['postgresql:', 'postgres:'].includes(url.protocol) ||
    !url.hostname || !url.username || !url.password || url.pathname.length < 2 ||
    url.password === 'SUBSTITUA_POR_UMA_SENHA_LOCAL'
  ) {
    throw new ConfigurationError('DATABASE_URL deve informar PostgreSQL, usuário, senha e banco válidos.');
  }
  return value;
}

export function getPort(): number {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT deve ser um inteiro entre 1 e 65535.');
  }
  return port;
}
