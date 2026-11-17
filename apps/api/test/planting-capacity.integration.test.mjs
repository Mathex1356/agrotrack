import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';

let prisma;
const rollback = new Error('Rollback D4 fixture');
const date = (value) => new Date(`${value}T00:00:00Z`);
const code = (e) => e?.meta?.driverAdapterError?.cause?.originalCode ?? e?.meta?.code ?? e?.code ?? 'UNKNOWN';
before(async () => { loadEnvironment(); prisma = new PrismaService(); await prisma.onModuleInit(); });
after(async () => { await prisma?.$disconnect(); });

async function fixture(tx) {
  const organization = await tx.organization.create({ data: { name: 'Capacity fixture', referenceCode: `D4-${randomUUID().toUpperCase()}` } });
  const farm = await tx.farm.create({ data: { organizationId: organization.id, code: 'F', name: 'Farm', municipality: 'Test', state: 'SP', country: 'BR', timezone: 'America/Sao_Paulo', totalAreaHa: '1000', productiveAreaHa: '1000' } });
  const field = await tx.field.create({ data: { organizationId: organization.id, farmId: farm.id, code: 'FIELD', name: 'Field', areaHa: '100' } });
  const season = await tx.season.create({ data: { organizationId: organization.id, farmId: farm.id, code: 'SEASON', name: 'Season', startDate: date('2026-01-01'), expectedEndDate: date('2027-01-01') } });
  const crop = await tx.crop.create({ data: { organizationId: organization.id, scope: 'ORGANIZATION', code: 'CROP', name: 'Crop' } });
  return { organization, farm, field, season, crop };
}
const planting = (tx, f, overrides = {}) => tx.planting.create({ data: {
  organizationId: f.organization.id, farmId: f.farm.id, fieldId: f.field.id, seasonId: f.season.id, cropId: f.crop.id,
  plannedAreaHa: '60', plannedStartDate: date('2026-01-01'), ...overrides,
} });
const occupied = (area = '60', start = '2026-01-01', end = null, status = end ? 'FINISHED' : 'IN_PROGRESS') => ({
  actualAreaHa: area, actualStartDate: date(start), actualEndDate: end ? date(end) : null, status,
});
const peak = async (tx, f) => (await tx.$queryRaw`SELECT planting_occupation_peak(${f.organization.id}::uuid, ${f.farm.id}::uuid, ${f.field.id}::uuid) AS peak`)[0].peak.toString();
async function scenario(run, expected) {
  let ready = false;
  try {
    await prisma.$transaction(async (tx) => { const f = await fixture(tx); ready = true; await run(tx, f); throw rollback; }, { timeout: 15000 });
  } catch (error) {
    if (error === rollback) { assert.equal(expected, undefined, 'Expected rejection'); return; }
    if (error?.name === 'AssertionError') throw error;
    assert.ok(ready, `Fixture error: ${code(error)}`);
    assert.ok(expected?.includes(code(error)), `Unexpected database code: ${code(error)}`);
  }
}
const ok = (name, run) => test(`D4: ${name}`, () => scenario(run));
const no = (name, run) => test(`D4: ${name}`, () => scenario(run, ['23514']));

ok('60 plus 40 exact occupancy and PLANNED rows do not reserve capacity', async (tx, f) => {
  await planting(tx, f, occupied()); await planting(tx, f, occupied('40'));
  await planting(tx, f, { plannedAreaHa: '100' }); await planting(tx, f, { plannedAreaHa: '100' });
  assert.equal(await peak(tx, f), '100');
});
no('60 plus 50 overlap rejected', async (tx, f) => { await planting(tx, f, occupied()); await planting(tx, f, occupied('50')); });
ok('adjacent half-open intervals share endpoint without double counting; peak is not intersecting total', async (tx, f) => {
  await planting(tx, f, occupied('60', '2026-01-01', '2026-03-01'));
  await planting(tx, f, occupied('60', '2026-03-01', '2026-05-01'));
  await planting(tx, f, occupied('40', '2026-02-01', '2026-04-01'));
  assert.equal(await peak(tx, f), '100');
});
no('unknown end remains occupied despite elapsed expected end', async (tx, f) => {
  await planting(tx, f, { ...occupied(), expectedEndDate: date('2026-02-01') });
  await planting(tx, f, occupied('50', '2030-01-01'));
});
for (const status of ['FINISHED', 'CANCELLED']) {
  no(`${status} retains historical occupancy`, async (tx, f) => {
    await planting(tx, f, occupied('60', '2026-01-01', '2026-03-01', status));
    await planting(tx, f, occupied('50', '2026-02-01', '2026-04-01'));
  });
}
ok('cancel without execution does not occupy; executed cancellation preserves interval', async (tx, f) => {
  await planting(tx, f, { status: 'CANCELLED' });
  const p = await planting(tx, f, occupied('60', '2026-01-01', '2026-03-01'));
  await tx.planting.update({ where: { id: p.id }, data: { status: 'CANCELLED' } });
  assert.equal(await peak(tx, f), '60');
});
for (const status of ['PLANNED', 'CANCELLED']) no(`cannot clear recorded execution by moving to ${status}`, async (tx, f) => {
  const p = await planting(tx, f, occupied('60', '2026-01-01', '2026-03-01'));
  await tx.planting.update({ where: { id: p.id }, data: { status, actualAreaHa: null, actualStartDate: null, actualEndDate: null } });
});
for (const [label, data] of [
  ['planned with execution', { ...occupied(), status: 'PLANNED' }],
  ['in progress without execution', { status: 'IN_PROGRESS' }],
  ['in progress with end', occupied('60', '2026-01-01', '2026-03-01', 'IN_PROGRESS')],
  ['finished without end', { ...occupied(), status: 'FINISHED' }],
  ['cancelled with open execution', { ...occupied(), status: 'CANCELLED' }],
  ['equal start and end', occupied('60', '2026-01-01', '2026-01-01')],
  ['end before start', occupied('60', '2026-02-01', '2026-01-01')],
]) no(`lifecycle rejects ${label}`, (tx, f) => planting(tx, f, data));
no('Field reduction rejects historical peak although individuals fit', async (tx, f) => {
  await planting(tx, f, occupied('60', '2026-01-01', '2026-03-01'));
  await planting(tx, f, occupied('40', '2026-01-01', '2026-03-01', 'CANCELLED'));
  await tx.field.update({ where: { id: f.field.id }, data: { areaHa: '80' } });
});
ok('Field reduction to exact peak remains valid', async (tx, f) => {
  await planting(tx, f, occupied('40')); await planting(tx, f, occupied('30'));
  await tx.field.update({ where: { id: f.field.id }, data: { areaHa: '70' } });
});
no('one millionth hectare over capacity rejected using NUMERIC', async (tx, f) => {
  await planting(tx, f, occupied('60.000001')); await planting(tx, f, occupied('40'));
});
ok('exact fractional sum accepted without float rounding', async (tx, f) => {
  await planting(tx, f, occupied('60.000001')); await planting(tx, f, occupied('39.999999'));
  assert.equal(await peak(tx, f), '100');
});
no('date-only update cannot move history into occupied interval', async (tx, f) => {
  await planting(tx, f, occupied('60', '2026-01-01', '2026-03-01'));
  const p = await planting(tx, f, occupied('60', '2026-03-01', '2026-05-01'));
  await tx.planting.update({ where: { id: p.id }, data: { actualStartDate: date('2026-02-01') } });
});
ok('multi-row direct SQL validates final state without OLD/NEW double count', async (tx, f) => {
  const a = await planting(tx, f, occupied('60')); const b = await planting(tx, f, occupied('40'));
  await tx.$executeRaw`UPDATE "Planting" SET "actualAreaHa" = CASE WHEN id=${a.id}::uuid THEN 40 ELSE 60 END WHERE id IN (${a.id}::uuid, ${b.id}::uuid)`;
  assert.equal(await peak(tx, f), '100');
  const fieldBefore = await tx.field.findUniqueOrThrow({ where: { id: f.field.id } });
  await tx.$executeRaw`SAVEPOINT d4_atomic`;
  await assert.rejects(tx.$executeRaw`UPDATE "Planting" SET "actualAreaHa"=60 WHERE id IN (${a.id}::uuid, ${b.id}::uuid)`, (e) => code(e) === '23514');
  await tx.$executeRaw`ROLLBACK TO SAVEPOINT d4_atomic`;
  assert.equal(await peak(tx, f), '100');
  assert.equal((await tx.planting.findUniqueOrThrow({ where: { id: a.id } })).actualAreaHa.toString(), '40');
  const fieldAfter = await tx.field.findUniqueOrThrow({ where: { id: f.field.id } });
  assert.deepEqual(fieldAfter, fieldBefore, 'Failed statement preserves area, timestamps and geometry revision');
});
ok('multi-row INSERT rejects atomically and preserves previous rows', async (tx, f) => {
  await tx.$executeRaw`SAVEPOINT d4_insert`;
  await assert.rejects(tx.$executeRaw`INSERT INTO "Planting" ("organizationId","farmId","fieldId","seasonId","cropId","plannedAreaHa","plannedStartDate","actualAreaHa","actualStartDate",status)
    SELECT ${f.organization.id}::uuid,${f.farm.id}::uuid,${f.field.id}::uuid,${f.season.id}::uuid,${f.crop.id}::uuid,60,'2026-01-01'::date,60,'2026-01-01'::date,'IN_PROGRESS'::"PlantingStatus" FROM generate_series(1,2)`, (e) => code(e) === '23514');
  await tx.$executeRaw`ROLLBACK TO SAVEPOINT d4_insert`;
  assert.equal(await tx.planting.count({ where: { fieldId: f.field.id } }), 0);
});

async function cleanup(f) {
  await prisma.$transaction(async (tx) => {
    const where = { organizationId: f.organization.id };
    await tx.planting.deleteMany({ where }); await tx.field.deleteMany({ where });
    await tx.season.deleteMany({ where }); await tx.crop.deleteMany({ where });
    await tx.farm.deleteMany({ where }); await tx.organization.delete({ where: { id: f.organization.id } });
  });
}
for (const isolationLevel of ['ReadCommitted', 'RepeatableRead']) for (const kind of ['two occupations', 'occupation first', 'reduction first', 'date revision', 'activation', 'area increase']) {
  test(`D4 concurrency: ${isolationLevel}, ${kind}`, async () => {
    const f = await prisma.$transaction(fixture);
    const release = Promise.withResolvers(); const written = Promise.withResolvers(); const pidReady = Promise.withResolvers();
    let one, two;
    try {
      let future;
      if (kind === 'date revision') future = await planting(prisma, f, occupied('60', '2026-04-01', '2026-05-01'));
      if (kind === 'activation') future = await planting(prisma, f);
      if (kind === 'area increase') future = await planting(prisma, f, occupied('20', '2026-01-01', '2026-03-01'));
      const occupy = (tx) => planting(tx, f, occupied('60', '2026-01-01', '2026-03-01'));
      const reduce = (tx) => tx.field.update({ where: { id: f.field.id }, data: { areaHa: '80' } });
      if (kind.includes('first')) await planting(prisma, f, occupied('40', '2026-01-01', '2026-03-01'));
      one = prisma.$transaction(async (tx) => {
        await (kind === 'reduction first' ? reduce(tx) : occupy(tx)); written.resolve(); await release.promise;
      }, { isolationLevel, timeout: 15000 }).then(() => null, (e) => { written.resolve(); return code(e); });
      await written.promise;
      two = prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        // Establish a snapshot before waiting, including Repeatable Read.
        await tx.field.findUniqueOrThrow({ where: { id: f.field.id } }); pidReady.resolve(row.pid);
        if (kind === 'occupation first') await reduce(tx);
        else if (kind === 'date revision') await tx.planting.update({ where: { id: future.id }, data: { actualStartDate: date('2026-02-01') } });
        else if (kind === 'activation') await tx.planting.update({ where: { id: future.id }, data: occupied('50', '2026-01-01', '2026-03-01') });
        else if (kind === 'area increase') await tx.planting.update({ where: { id: future.id }, data: { actualAreaHa: '50' } });
        else await occupy(tx);
      }, { isolationLevel, timeout: 15000 }).then(() => null, (e) => { pidReady.resolve(null); return code(e); });
      const pid = await pidReady.promise; let blocked = false;
      const deadline = Date.now() + 2000;
      while (pid && Date.now() < deadline) {
        const [row] = await prisma.$queryRaw`SELECT cardinality(pg_blocking_pids(${pid}::integer)) > 0 AS blocked`;
        if (row.blocked) { blocked = true; break; } await delay(20);
      }
      assert.ok(blocked, 'Second writer must actually wait for Field'); release.resolve();
      assert.equal(await one, null);
      const rejected = await two;
      assert.ok(isolationLevel === 'RepeatableRead' ? ['40001', 'P2034'].includes(rejected) : rejected === '23514', `Unexpected failure: ${rejected}`);
      const current = await prisma.field.findUniqueOrThrow({ where: { id: f.field.id } });
      assert.ok(current.areaHa.greaterThanOrEqualTo(await peak(prisma, f)));
    } finally { release.resolve(); await Promise.allSettled([one, two].filter(Boolean)); await cleanup(f); }
  });
}
