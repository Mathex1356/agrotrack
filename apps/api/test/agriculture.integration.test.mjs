import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { seedGlobalCrops, globalCrops } from '../prisma/crops.mjs';

let prisma;
const rollback = new Error('Rollback agricultural fixture');
const date = (value) => new Date(`${value}T00:00:00Z`);
const check = ['23514'];
const fk = ['23503', 'P2003'];
const unique = ['23505', 'P2002'];
const code = (e) => e?.meta?.driverAdapterError?.cause?.originalCode ?? e?.meta?.code ?? e?.code ?? 'UNKNOWN';
before(async () => { loadEnvironment(); prisma = new PrismaService(); await prisma.onModuleInit(); });
after(async () => { await prisma?.$disconnect(); });

async function fixture(tx) {
  const tag = randomUUID().toUpperCase();
  const a = await tx.organization.create({ data: { name: 'Agricultural test A', referenceCode: `AG-A-${tag}` } });
  const b = await tx.organization.create({ data: { name: 'Agricultural test B', referenceCode: `AG-B-${tag}` } });
  const farmData = { name: 'Test farm', municipality: 'Test', state: 'SP', country: 'BR', timezone: 'America/Sao_Paulo', totalAreaHa: '1000', productiveAreaHa: '900' };
  const fa = await tx.farm.create({ data: { ...farmData, organizationId: a.id, code: 'F1' } });
  const fa2 = await tx.farm.create({ data: { ...farmData, organizationId: a.id, code: 'F2' } });
  const fb = await tx.farm.create({ data: { ...farmData, organizationId: b.id, code: 'F1' } });
  const fieldData = { organizationId: a.id, farmId: fa.id, code: 'FIELD-1', name: 'Test field', areaHa: '100' };
  const field = await tx.field.create({ data: fieldData });
  const fieldB = await tx.field.create({ data: { ...fieldData, organizationId: b.id, farmId: fb.id } });
  const seasonData = { organizationId: a.id, farmId: fa.id, code: '2026-27', name: 'Test season', startDate: date('2026-09-01'), expectedEndDate: date('2027-08-31') };
  const season = await tx.season.create({ data: seasonData });
  const season2 = await tx.season.create({ data: { ...seasonData, farmId: fa2.id } });
  const seasonB = await tx.season.create({ data: { ...seasonData, organizationId: b.id, farmId: fb.id } });
  const global = await tx.crop.create({ data: { scope: 'GLOBAL', code: `TEST-${tag}`, name: 'Test crop' } });
  const ca = await tx.crop.create({ data: { scope: 'ORGANIZATION', organizationId: a.id, code: 'CUSTOM', name: 'Test crop' } });
  const cb = await tx.crop.create({ data: { scope: 'ORGANIZATION', organizationId: b.id, code: 'CUSTOM', name: 'Test crop' } });
  const plantingData = { organizationId: a.id, farmId: fa.id, seasonId: season.id, fieldId: field.id, cropId: global.id, plannedAreaHa: '60', plannedStartDate: date('2026-10-01') };
  return { a, b, fa, fa2, fb, field, fieldB, season, season2, seasonB, global, ca, cb, fieldData, seasonData, plantingData };
}

async function scenario(run, expected) {
  let ready = false;
  try {
    await prisma.$transaction(async (tx) => {
      const f = await fixture(tx);
      ready = true;
      await run(tx, f);
      throw rollback;
    }, { timeout: 15000 });
  } catch (error) {
    if (error === rollback) { assert.equal(expected, undefined, 'Database should reject this operation'); return; }
    if (error?.name === 'AssertionError') throw error;
    assert.ok(ready, `Fixture failure: ${code(error)}`);
    assert.ok(expected?.includes(code(error)), `Unexpected database code: ${code(error)}`);
  }
}
const ok = (name, run) => test(name, () => scenario(run));
const no = (name, expected, run) => test(name, () => scenario(run, expected));
const plant = (tx, f, data = {}) => tx.planting.create({ data: { ...f.plantingData, ...data } });
const fieldUpdate = (tx, f, data) => tx.field.update({ where: { id: f.field.id }, data });
const boundary = (tx, f, ewkt) => tx.$executeRaw`UPDATE "Field" SET boundary = ST_GeomFromEWKT(${ewkt}) WHERE id = ${f.field.id}::uuid`;
const valid = 'SRID=4326;MULTIPOLYGON(((-50 -20,-49.99 -20,-49.99 -19.99,-50 -19.99,-50 -20)))';

ok('valid Field and Season without geometry; same field code across farms', async (tx, f) => {
  assert.equal(f.field.geometryRevision, 0);
  const [row] = await tx.$queryRaw`SELECT boundary IS NULL AS unmapped FROM "Field" WHERE id=${f.field.id}::uuid`;
  assert.equal(row.unmapped, true);
  await tx.field.create({ data: { ...f.fieldData, farmId: f.fa2.id } });
});
no('Field rejects farm of another tenant', fk, (tx, f) => tx.field.create({ data: { ...f.fieldData, organizationId: f.b.id } }));
for (const areaHa of ['0', '-1']) no(`Field rejects area ${areaHa}`, check, (tx, f) => fieldUpdate(tx, f, { areaHa }));
no('Field rejects NaN at PostgreSQL boundary', check, (tx, f) => tx.$executeRaw`UPDATE "Field" SET "areaHa"='NaN'::numeric WHERE id=${f.field.id}::uuid`);
no('Field code unique within farm', unique, (tx, f) => tx.field.create({ data: f.fieldData }));
no('GLOBAL Crop rejects organization', check, (tx, f) => tx.crop.create({ data: { scope: 'GLOBAL', organizationId: f.a.id, code: 'INVALID', name: 'Invalid' } }));
no('ORGANIZATION Crop requires organization', check, (tx) => tx.crop.create({ data: { scope: 'ORGANIZATION', code: 'INVALID', name: 'Invalid' } }));
no('GLOBAL Crop code unique', unique, (tx, f) => tx.crop.create({ data: { scope: 'GLOBAL', code: f.global.code, name: 'Duplicate' } }));
no('private Crop code unique within tenant', unique, (tx, f) => tx.crop.create({ data: { scope: 'ORGANIZATION', organizationId: f.a.id, code: f.ca.code, name: 'Duplicate' } }));
ok('private codes/names can repeat across tenants and global scope', async (tx, f) => {
  assert.equal(f.ca.code, f.cb.code);
  await tx.crop.create({ data: { scope: 'ORGANIZATION', organizationId: f.a.id, code: f.global.code, name: f.global.name } });
});
no('Crop scope immutable before use', check, (tx, f) => tx.crop.update({ where: { id: f.global.id }, data: { scope: 'ORGANIZATION', organizationId: f.a.id } }));
no('Crop tenant immutable after use', check, async (tx, f) => {
  await plant(tx, f, { cropId: f.ca.id });
  await tx.crop.update({ where: { id: f.ca.id }, data: { organizationId: f.b.id } });
});
ok('Season overlap allowed', (tx, f) => tx.season.create({ data: { ...f.seasonData, code: 'OVERLAP' } }));
no('Season rejects farm of another tenant', fk, (tx, f) => tx.season.create({ data: { ...f.seasonData, organizationId: f.b.id } }));
no('Season code unique within farm', unique, (tx, f) => tx.season.create({ data: f.seasonData }));
for (const column of ['expectedEndDate', 'actualEndDate']) no(`Season rejects early ${column}`, check, (tx, f) => tx.season.update({ where: { id: f.season.id }, data: { [column]: date('2026-08-01') } }));
ok('Planting accepts GLOBAL and same-tenant Crop with simultaneous subdivisions', async (tx, f) => {
  const actual = { status: 'IN_PROGRESS', actualStartDate: date('2026-10-01') };
  await plant(tx, f, { ...actual, actualAreaHa: '60' });
  await plant(tx, f, { ...actual, cropId: f.ca.id, plannedAreaHa: '40', actualAreaHa: '40' });
  assert.equal(await tx.planting.count({ where: { fieldId: f.field.id } }), 2);
});
no('Planting rejects Season from another farm in same tenant', fk, (tx, f) => plant(tx, f, { seasonId: f.season2.id }));
no('Planting rejects Field from another tenant', fk, (tx, f) => plant(tx, f, { fieldId: f.fieldB.id }));
no('Planting rejects Season from another tenant', fk, (tx, f) => plant(tx, f, { seasonId: f.seasonB.id }));
no('Planting rejects tenant inconsistent with farm/field', fk, (tx, f) => plant(tx, f, { organizationId: f.b.id }));
no('Planting rejects private Crop from another tenant', check, (tx, f) => plant(tx, f, { cropId: f.cb.id }));
no('Planting update cannot switch to private Crop from another tenant', check, async (tx, f) => {
  const p = await plant(tx, f);
  await tx.planting.update({ where: { id: p.id }, data: { cropId: f.cb.id } });
});
for (const column of ['plannedAreaHa', 'actualAreaHa']) {
  for (const value of ['0', '-1', '101']) no(`Planting rejects ${column}=${value}`, check, (tx, f) => plant(tx, f, { [column]: value }));
}
no('Planting rejects planned NaN at PostgreSQL boundary', check, async (tx, f) => {
  const p = await plant(tx, f);
  await tx.$executeRaw`UPDATE "Planting" SET "plannedAreaHa"='NaN'::numeric WHERE id=${p.id}::uuid`;
});
no('Planting rejects actual NaN at PostgreSQL boundary', check, async (tx, f) => {
  const p = await plant(tx, f);
  await tx.$executeRaw`UPDATE "Planting" SET "actualAreaHa"='NaN'::numeric WHERE id=${p.id}::uuid`;
});
no('Planting update rejects individual area overflow', check, async (tx, f) => {
  const p = await plant(tx, f);
  await tx.planting.update({ where: { id: p.id }, data: { actualAreaHa: '101' } });
});
no('Field reduction cannot invalidate an existing planting', check, async (tx, f) => { await plant(tx, f); await fieldUpdate(tx, f, { areaHa: '50' }); });
ok('Field may reduce capacity while all individual plantings still fit', async (tx, f) => { await plant(tx, f); await fieldUpdate(tx, f, { areaHa: '60' }); });
no('Planting expected end cannot precede planned start', check, (tx, f) => plant(tx, f, { expectedEndDate: date('2026-09-01') }));
no('Planting actual end cannot precede actual start', check, (tx, f) => plant(tx, f, { actualStartDate: date('2026-10-01'), actualEndDate: date('2026-09-01') }));
no('Planting actual end requires actual start', check, (tx, f) => plant(tx, f, { actualEndDate: date('2026-12-01') }));
for (const column of ['spacingMeters', 'populationPerHa']) no(`Planting rejects negative ${column}`, check, (tx, f) => plant(tx, f, { [column]: '-1' }));
ok('PLANNED plantings do not reserve aggregate capacity', async (tx, f) => { await plant(tx, f); await plant(tx, f); });
ok('documented limit: aggregate effective occupancy is not yet enforced', async (tx, f) => {
  await plant(tx, f, { status: 'IN_PROGRESS', actualAreaHa: '60', actualStartDate: date('2026-10-01') });
  await plant(tx, f, { status: 'IN_PROGRESS', actualAreaHa: '50', actualStartDate: date('2026-10-01') });
});
no('Field with planting cannot cascade delete', ['23001', 'P2003'], async (tx, f) => { await plant(tx, f); await tx.field.delete({ where: { id: f.field.id } }); });
ok('inactivation preserves planting history', async (tx, f) => {
  await plant(tx, f);
  await fieldUpdate(tx, f, { status: 'INACTIVE' });
  await tx.crop.update({ where: { id: f.global.id }, data: { status: 'INACTIVE' } });
  assert.equal(await tx.planting.count({ where: { fieldId: f.field.id } }), 1);
});

ok('MultiPolygon 4326 and geography hectares; revision owned by database', async (tx, f) => {
  await boundary(tx, f, valid);
  const [row] = await tx.$queryRaw`SELECT ST_SRID(boundary) AS srid, ST_GeometryType(boundary) AS type,
    ST_Area(boundary::geography)/10000 AS hectares, "areaHa", "geometryRevision" FROM "Field" WHERE id=${f.field.id}::uuid`;
  assert.equal(row.srid, 4326); assert.equal(row.type, 'ST_MultiPolygon');
  assert.ok(row.hectares > 110 && row.hectares < 120);
  assert.equal(row.areaHa.toString(), '100'); assert.equal(row.geometryRevision, 1);
  await boundary(tx, f, valid);
  const unchanged = await fieldUpdate(tx, f, { geometryRevision: 99 });
  assert.equal(unchanged.geometryRevision, 1);
  await tx.$executeRaw`UPDATE "Field" SET boundary=NULL WHERE id=${f.field.id}::uuid`;
  assert.equal((await tx.field.findUniqueOrThrow({ where: { id: f.field.id } })).geometryRevision, 2);
});
no('self-intersecting geometry rejected', check, (tx, f) => boundary(tx, f, 'SRID=4326;MULTIPOLYGON(((0 0,1 1,1 0,0 1,0 0)))'));
no('empty geometry rejected', check, (tx, f) => boundary(tx, f, 'SRID=4326;MULTIPOLYGON EMPTY'));
ok('Polygon safely promoted to MultiPolygon without changing footprint', async (tx, f) => {
  const polygon = 'SRID=4326;POLYGON((0 0,1 0,1 1,0 0))';
  await boundary(tx, f, polygon);
  const [row] = await tx.$queryRaw`SELECT ST_GeometryType(boundary) AS type,
    ST_Equals(boundary,ST_GeomFromEWKT(${polygon})) AS unchanged FROM "Field" WHERE id=${f.field.id}::uuid`;
  assert.equal(row.type, 'ST_MultiPolygon'); assert.equal(row.unchanged, true);
});
no('Point geometry rejected', ['22023'], (tx, f) => boundary(tx, f, 'SRID=4326;POINT(0 0)'));
no('wrong SRID rejected', ['22023'], (tx, f) => boundary(tx, f, valid.replace('4326', '3857')));
no('out-of-range coordinates rejected', check, (tx, f) => boundary(tx, f, 'SRID=4326;MULTIPOLYGON(((181 0,182 0,182 1,181 0)))'));
no('3D geometry rejected', ['22023'], (tx, f) => boundary(tx, f, 'SRID=4326;MULTIPOLYGON Z (((0 0 1,1 0 1,1 1 1,0 0 1)))'));
ok('PostGIS typmod assigns 4326 to SRID 0; caller must supply WGS84 coordinates', async (tx, f) => {
  await boundary(tx, f, valid.replace('4326', '0'));
  const [row] = await tx.$queryRaw`SELECT ST_SRID(boundary) AS srid FROM "Field" WHERE id=${f.field.id}::uuid`;
  assert.equal(row.srid, 4326);
});
ok('global crop seed repeatable and preserves private catalogs', async (tx, f) => {
  await seedGlobalCrops(tx);
  const before = await tx.crop.findMany({ where: { scope: 'GLOBAL', code: { in: globalCrops.map(([c]) => c) } }, orderBy: { code: 'asc' } });
  await seedGlobalCrops(tx);
  const after = await tx.crop.findMany({ where: { id: { in: before.map((c) => c.id) } }, orderBy: { code: 'asc' } });
  assert.equal(before.length, 8); assert.deepEqual(after, before);
  assert.equal(await tx.crop.count({ where: { organizationId: f.a.id } }), 1);
});

// These tests commit only uniquely identified test fixtures and remove exactly
// those IDs in finally. Two writers + observer; no sleeps used as lock evidence.
async function cleanup(f) {
  const tenants = { in: [f.a.id, f.b.id] };
  await prisma.$transaction(async (tx) => {
    await tx.planting.deleteMany({ where: { organizationId: tenants } });
    await tx.field.deleteMany({ where: { organizationId: tenants } });
    await tx.season.deleteMany({ where: { organizationId: tenants } });
    await tx.crop.deleteMany({ where: { id: { in: [f.global.id, f.ca.id, f.cb.id] } } });
    await tx.farm.deleteMany({ where: { organizationId: tenants } });
    await tx.organization.deleteMany({ where: { id: tenants } });
  });
}

for (const isolationLevel of ['ReadCommitted', 'RepeatableRead']) {
  for (const first of ['planting', 'reduction']) {
    test(`individual capacity concurrent ${isolationLevel}, ${first} first`, async () => {
      const f = await prisma.$transaction(fixture);
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      const secondPid = Promise.withResolvers();
      let writer1, writer2;
      try {
        const writePlanting = (tx) => plant(tx, f, { plannedAreaHa: '80' });
        const reduce = (tx) => fieldUpdate(tx, f, { areaHa: '50' });
        writer1 = prisma.$transaction(async (tx) => {
          await (first === 'planting' ? writePlanting(tx) : reduce(tx));
          started.resolve();
          await release.promise;
        }, { isolationLevel, timeout: 15000 }).then(() => null, (e) => { started.resolve(); return code(e); });
        await started.promise;
        writer2 = prisma.$transaction(async (tx) => {
          const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
          secondPid.resolve(row.pid);
          await (first === 'planting' ? reduce(tx) : writePlanting(tx));
        }, { isolationLevel, timeout: 15000 }).then(() => null, (e) => { secondPid.resolve(null); return code(e); });
        const pid = await secondPid.promise;
        let blocked = false;
        const deadline = Date.now() + 2000;
        while (pid && Date.now() < deadline) {
          const [row] = await prisma.$queryRaw`SELECT cardinality(pg_blocking_pids(${pid}::integer)) > 0 AS blocked`;
          if (row.blocked) { blocked = true; break; }
          await delay(20);
        }
        assert.ok(blocked, 'Second writer must wait for Field lock');
        release.resolve();
        assert.equal(await writer1, null);
        assert.ok(['23514', '40001', 'P2034'].includes(await writer2), 'Conflicting writer must fail');
        const current = await txState(f);
        assert.equal(current.area, first === 'planting' ? '100' : '50');
        assert.equal(current.count, first === 'planting' ? 1 : 0);
      } finally {
        release.resolve();
        await Promise.allSettled([writer1, writer2].filter(Boolean));
        await cleanup(f);
      }
    });
  }
}

async function txState(f) {
  const field = await prisma.field.findUniqueOrThrow({ where: { id: f.field.id } });
  return { area: field.areaHa.toString(), count: await prisma.planting.count({ where: { fieldId: f.field.id } }) };
}
