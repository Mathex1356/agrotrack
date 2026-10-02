import { defineConfig } from 'prisma/config';
import { getDatabaseUrl, loadEnvironment } from './src/config/environment';

loadEnvironment();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'node prisma/seed.mjs' },
  datasource: { url: getDatabaseUrl() },
});
