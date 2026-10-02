import { defineConfig } from 'prisma/config';
import { getDatabaseUrl, loadEnvironment } from './src/config/environment';

loadEnvironment();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: getDatabaseUrl() },
});
