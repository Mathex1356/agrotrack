import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';

let prisma;
try {
  loadEnvironment();
  prisma = new PrismaService();
  await prisma.onModuleInit();
  const result = await prisma.$queryRaw`
    SELECT current_setting('server_version') AS postgresql,
           postgis_lib_version() AS postgis,
           postgis_full_version() AS details
  `;
  console.log('Conexão Prisma e extensão PostGIS confirmadas:');
  console.log(result);
} catch {
  console.error('Falha na verificação. Revise o .env, o serviço do banco e a extensão PostGIS.');
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
