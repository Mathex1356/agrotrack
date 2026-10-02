export const globalCrops = [
  ['SOYBEAN', 'Soja'], ['CORN', 'Milho'], ['COTTON', 'Algodão'],
  ['BEAN', 'Feijão'], ['WHEAT', 'Trigo'], ['COFFEE', 'Café'],
  ['SORGHUM', 'Sorgo'], ['SUGARCANE', 'Cana-de-açúcar'],
];

export async function seedGlobalCrops(tx) {
  for (const [code, name] of globalCrops) {
    // Partial uniqueness is maintained by PostgreSQL, including concurrent seeds.
    await tx.$executeRaw`
      INSERT INTO "Crop" ("scope", "code", "name") VALUES ('GLOBAL', ${code}, ${name})
      ON CONFLICT ("code") WHERE "scope" = 'GLOBAL'
      DO UPDATE SET "name" = EXCLUDED."name", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "Crop"."name" IS DISTINCT FROM EXCLUDED."name"
    `;
  }
}
