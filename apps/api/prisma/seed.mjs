import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { seedPermissions } from './permissions.mjs';

let prisma;
try {
  loadEnvironment();
  prisma = new PrismaService();
  await prisma.$transaction(seedPermissions);
  console.log('Catálogo global de permissões preparado. Nenhum tenant foi criado.');
} catch {
  console.error('Falha no seed. Verifique configuração, conexão e migrations.');
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
