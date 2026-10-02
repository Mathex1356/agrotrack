import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { seedPermissions } from './permissions.mjs';
import { seedGlobalCrops } from './crops.mjs';

let prisma;
try {
  loadEnvironment();
  prisma = new PrismaService();
  await prisma.$transaction(async (tx) => {
    await seedPermissions(tx);
    await seedGlobalCrops(tx);
  });
  console.log('Catálogos globais de permissões e culturas preparados. Nenhum tenant foi criado.');
} catch {
  console.error('Falha no seed. Verifique configuração, conexão e migrations.');
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
