import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttp } from './http-security.js';
import { AppModule } from './app.module.js';
import { ConfigurationError, getDatabaseUrl, getPort, loadEnvironment } from './config/environment.js';

async function bootstrap(): Promise<void> {
  loadEnvironment();
  getDatabaseUrl();
  const port = getPort();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { abortOnError: false, bodyParser: false });
  configureHttp(app);
  app.enableShutdownHooks();
  try {
    await app.listen(port, '127.0.0.1');
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  Logger.error(
    error instanceof ConfigurationError
      ? error.message
      : 'Falha ao iniciar a API. Verifique a configuração, a porta e a disponibilidade do banco local.',
    undefined,
    'Bootstrap',
  );
  process.exitCode = 1;
});
