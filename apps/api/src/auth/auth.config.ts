import { Injectable } from '@nestjs/common';
import { ConfigurationError } from '../config/environment.js';

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${name} fora do intervalo permitido.`);
  }
  return value;
}

function secret(name: string): Uint8Array {
  const value = process.env[name] ?? '';
  if (!/^[A-Za-z0-9_-]{43,}$/.test(value) || /SUBSTITUA|CHANGE_ME/i.test(value)) {
    throw new ConfigurationError(`${name} exige segredo aleatorio base64url de pelo menos 32 bytes.`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 32 || bytes.toString('base64url') !== value) {
    throw new ConfigurationError(`${name} invalido.`);
  }
  return bytes;
}

@Injectable()
export class AuthConfig {
  readonly production = process.env.NODE_ENV === 'production';
  readonly jwtKey = secret('AUTH_JWT_SECRET');
  readonly rateKey = secret('AUTH_RATE_LIMIT_SECRET');
  readonly issuer = 'agrotrack-api';
  readonly audience = 'agrotrack-web';
  readonly accessSeconds = integer('AUTH_ACCESS_TTL_SECONDS', 300, 30, 900);
  readonly refreshSeconds = integer('AUTH_REFRESH_TTL_SECONDS', 604800, 60, 2592000);
  readonly sessionSeconds = integer('AUTH_SESSION_TTL_SECONDS', 2592000, 60, 7776000);
  readonly rateWindowSeconds = integer('AUTH_RATE_WINDOW_SECONDS', 900, 1, 3600);
  readonly loginIpLimit = integer('AUTH_LOGIN_IP_LIMIT', 30, 1, 1000);
  readonly loginEmailLimit = integer('AUTH_LOGIN_EMAIL_LIMIT', 10, 1, 100);
  readonly refreshIpLimit = integer('AUTH_REFRESH_IP_LIMIT', 60, 1, 1000);
  readonly origins: string[];
  readonly cookieName: string;

  constructor() {
    if (!['development', 'test', 'production'].includes(process.env.NODE_ENV ?? '')) {
      throw new ConfigurationError('NODE_ENV deve ser development, test ou production.');
    }
    this.origins = (process.env.AUTH_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim());
    if (!this.origins.length || this.origins.some(origin => {
      try {
        const url = new URL(origin);
        return url.origin !== origin || !['http:', 'https:'].includes(url.protocol)
          || (this.production && url.protocol !== 'https:') || !!url.username || !!url.password;
      } catch { return true; }
    })) throw new ConfigurationError('AUTH_ALLOWED_ORIGINS exige origens exatas; HTTPS em producao.');
    if (Buffer.from(this.jwtKey).equals(Buffer.from(this.rateKey))) {
      throw new ConfigurationError('Os segredos de autenticacao devem ser independentes.');
    }
    this.cookieName = this.production ? '__Secure-agrotrack_refresh' : 'agrotrack_refresh';
  }
}
