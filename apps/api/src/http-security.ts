import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { AuthConfig } from './auth/auth.config.js';

// Never pass database/crypto errors to Nest's default exception logger.
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const parser = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
    const parserStatus = parser === 'entity.too.large' ? 413 : parser === 'entity.parse.failed' ? 400 : undefined;
    const status = parserStatus ?? (error instanceof HttpException ? error.getStatus() : 500);
    const body = [400, 413].includes(status) ? { statusCode: status, message: 'Entrada invalida.' }
      : error instanceof HttpException ? error.getResponse() : { statusCode: 500, message: 'Falha interna.' };
    response.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
  }
}

export function configureHttp(app: NestExpressApplication): void {
  const config = app.get(AuthConfig);
  app.set('trust proxy', false);
  app.disable('x-powered-by');
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.enableCors({ origin: config.origins, credentials: true, methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-AgroTrack-CSRF', 'X-Organization-Membership-Id'] });
  app.useBodyParser('json', { limit: '8kb' });
  app.useGlobalFilters(new SafeExceptionFilter());
}
