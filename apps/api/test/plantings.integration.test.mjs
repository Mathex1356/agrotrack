import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';


import { after, before, test } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { SignJWT } from 'jose';
import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { AuthGuard } from '../dist/auth/auth.guard.js';
import { AuthConfig } from '../dist/auth/auth.config.js';
import { PasswordService } from '../dist/auth/password.service.js';
import { AuthorizationService } from '../dist/authorization/authorization.service.js';
import { PermissionGuard } from '../dist/authorization/permission.guard.js';
import { PlantingsService } from '../dist/plantings/plantings.service.js';

import { PlantingsController } from '../dist/plantings/plantings.controller.js';

import { configureHttp } from '../dist/http-security.js';
import { provisionSystemRoles } from '../prisma/permissions.mjs';

let db, config;
const rollback = new Error('Rollback planting fixtures');
const input = { code: 'FARM', name: 'Farm', municipality: 'Municipality', state: 'SP', country: 'BR', timezone: 'America/Sao_Paulo', totalAreaHa: '100', productiveAreaHa: '80' };
before(async () => {
  loadEnvironment();
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.AUTH_RATE_LIMIT_SECRET = randomBytes(32).toString('base64url');
  process.env.AUTH_ALLOWED_ORIGINS = 'http://localhost:5173';
  config = new AuthConfig(); db = new PrismaService(); await db.onModuleInit();
});
after(async () => { await db?.$disconnect(); });

async function fixtures(tx, custom = false) {
  const userId = randomUUID(), aId = randomUUID(), bId = randomUUID();
  await tx.user.create({ data: { id: userId, displayName: 'Farm test', email: `${userId}@example.test`, normalizedEmail: `${userId}@example.test` } });
  for (const id of [aId, bId]) await tx.organization.create({ data: { id, name: 'Farm test', referenceCode: id.toUpperCase(), status: 'ACTIVE' } });
  let roles;
  if (custom) {
    const role = await tx.role.create({ data: { organizationId: aId, name: 'Concurrent test' } });
    roles = { OWNER: role, MANAGER: role, AGRONOMIST: role, WORKER: role };
    await tx.rolePermission.createMany({ data: ['farms.read', 'plantings.manage'].map(permissionCode => ({ organizationId: aId, roleId: role.id, permissionCode })) });
  } else {
    await provisionSystemRoles(tx, aId);
    roles = Object.fromEntries((await tx.role.findMany({ where: { organizationId: aId } })).map(role => [role.systemCode, role]));
  }
  const member = await tx.organizationMembership.create({ data: { organizationId: aId, userId, roleId: roles.OWNER.id } });
  const farms = [];
  for (const [organizationId, code] of [[aId, 'A1'], [aId, 'A2'], [bId, 'B1']]) farms.push(await tx.farm.create({ data: { ...input, organizationId, code } }));
  const [farm, hidden, foreign] = farms;
  const grant = await tx.farmMembership.create({ data: { organizationId: aId, organizationMembershipId: member.id, farmId: farm.id } });
  const session = await tx.authSession.create({ data: { userId, expiresAt: new Date(Date.now() + 600000) } });
  const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setSubject(userId).setIssuer(config.issuer).setAudience(config.audience).setIssuedAt().setExpirationTime('5m').sign(config.jwtKey);
  return { userId, aId, bId, roles, member, farm, hidden, foreign, grant, session, token };
}
async function harness(database, f, run) {
  class Harness {}
  Module({ controllers: [PlantingsController], providers: [
    { provide: PrismaService, useValue: database }, { provide: AuthConfig, useValue: config },
    { provide: PasswordService, useValue: {} }, AuthService, AuthorizationService, PermissionGuard, PlantingsService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ] })(Harness);
  const app = await NestFactory.create(Harness, { logger: false, abortOnError: false, bodyParser: false });
  configureHttp(app);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const request = async (path = '/farms', { method = 'GET', body, token = f.token, membership = f.member.id, headers = {} } = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(membership ? { 'X-Organization-Membership-Id': membership } : {}),
        'Content-Type': 'application/json', ...headers,
      }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
    };
    await run(request, app.get(PlantingsService));
  } finally { await app.close(); }
}
function delegates(tx) {
  return { authSession: tx.authSession, organizationMembership: tx.organizationMembership, farm: tx.farm, field: tx.field, crop: tx.crop, season: tx.season, planting: tx.planting, user: tx.user };
}
async function scenario(run) {
  try {
    await db.$transaction(async tx => {
      const f = await fixtures(tx);
      f.field = await tx.field.create({ data: { organizationId: f.aId, farmId: f.farm.id, code: 'F', name: 'Field', areaHa: '100' } });
      f.season = await tx.season.create({ data: { organizationId: f.aId, farmId: f.farm.id, code: 'S', name: 'Season', startDate: new Date('2026-01-01'), expectedEndDate: new Date('2026-12-31') } });
      f.crop = await tx.crop.findFirstOrThrow({ where: { scope: 'GLOBAL', status: 'ACTIVE' } });
      const facade = { ...delegates(tx), $transaction: async operation => {
        await tx.$executeRawUnsafe('SAVEPOINT farm_http');
        try { const result = await operation(tx); await tx.$executeRawUnsafe('RELEASE SAVEPOINT farm_http'); return result; }
        catch (error) { await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT farm_http'); await tx.$executeRawUnsafe('RELEASE SAVEPOINT farm_http'); throw error; }
      } };
      await harness(facade, f, request => run(tx, f, request));
      throw rollback;
    }, { timeout: 25000 });
  } catch (error) {
    if (error === rollback) return;
    if (error?.name === 'AssertionError') throw error;
    // Prisma causes may carry sensitive arguments; never print them.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Farm test failed safely (${error?.code ?? error?.name ?? 'unknown'}).`);
  }
}

const path = f => `/farms/${f.farm.id}/plantings`;
const data = f => ({ fieldId: f.field.id, seasonId: f.season.id, cropId: f.crop.id, plannedAreaHa: '60', plannedStartDate: '2026-01-01' });
const post = (request, f, body = data(f)) => request(path(f), { method: 'POST', body });
const patch = (request, f, id, body) => request(`${path(f)}/${id}`, { method: 'PATCH', body });

test('plantings HTTP: planned creation, multiple crops without reservation, exact decimals and partial edits', () => scenario(async (tx, f, request) => {
  const created = await post(request, f, { ...data(f), spacingMeters: '0.000001', populationPerHa: '12345678901234.123456', expectedEndDate: '2026-03-01', variety: 'Test' });
  assert.equal(created.status, 201); assert.equal(created.body.status, 'PLANNED');
  assert.equal(created.body.actualAreaHa, null); assert.equal(created.body.spacingMeters, '0.000001');
  assert.equal(created.body.populationPerHa, '12345678901234.123456'); assert.equal('organizationId' in created.body, false);
  const otherCrop = await tx.crop.create({ data: { organizationId: f.aId, scope: 'ORGANIZATION', code: 'CUSTOM', name: 'Custom' } });
  assert.equal((await post(request, f, { ...data(f), cropId: otherCrop.id })).status, 201);
  const changed = await patch(request, f, created.body.id, { notes: 'Changed', variety: null });
  assert.equal(changed.status, 200); assert.equal(changed.body.plannedAreaHa, '60'); assert.equal(changed.body.variety, null);
  assert.equal((await patch(request, f, created.body.id, { plannedStartDate: '2026-04-01' })).status, 400);
  assert.equal((await patch(request, f, created.body.id, { expectedEndDate: null, plannedStartDate: '2026-04-01' })).status, 200);
  assert.equal((await post(request, f, { ...data(f), plannedAreaHa: '100.000001' })).status, 409);
  const first = await request(`${path(f)}?limit=1`), second = await request(`${path(f)}?limit=1&offset=1`);
  assert.equal(first.body.hasMore, true); assert.notEqual(first.body.items[0].id, second.body.items[0].id);
  assert.equal((await request(`${path(f)}?cropId=${otherCrop.id}&status=PLANNED`)).body.items.length, 1);
  assert.equal((await request(`${path(f)}?fieldId=${randomUUID()}`)).body.items.length, 0);
}));

for (const role of ['OWNER', 'MANAGER', 'AGRONOMIST', 'WORKER']) test(`plantings HTTP: ${role} capability and territory`, () => scenario(async (tx, f, request) => {
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles[role].id } });
  assert.equal((await post(request, f)).status, role === 'WORKER' ? 403 : 201);
  assert.equal((await request(path(f))).status, role === 'WORKER' ? 403 : 200);
  await tx.farmMembership.update({ where: { id: f.grant.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  assert.equal((await request(path(f))).status, role === 'OWNER' ? 200 : role === 'WORKER' ? 403 : 404);
  assert.equal((await post(request, f)).status, role === 'OWNER' ? 201 : role === 'WORKER' ? 403 : 404);
}));

test('plantings HTTP: authentication, inactive membership and permission changes apply immediately', () => scenario(async (tx, f, request) => {
  assert.equal((await request(path(f), { token: '' })).status, 401);
  assert.equal((await request(path(f), { membership: randomUUID() })).status, 403);
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.OWNER.id, permissionCode: 'plantings.manage' } } });
  assert.equal((await post(request, f)).status, 403);
  await tx.permission.update({ where: { code: 'farms.read' }, data: { status: 'INACTIVE' } });
  assert.equal((await request(path(f))).status, 403);
}));

test('plantings HTTP: tenant, farm, field, season and crop isolation with uniform 404', () => scenario(async (tx, f, request) => {
  const created = await post(request, f);
  for (const farmId of [f.foreign.id, f.hidden.id, randomUUID(), 'invalid']) {
    assert.equal((await request(`/farms/${farmId}/plantings/${created.body.id}`)).status, 404);
  }
  for (const id of [randomUUID(), 'invalid']) assert.equal((await request(`${path(f)}/${id}`)).status, 404);
  const otherField = await tx.field.create({ data: { organizationId: f.aId, farmId: f.hidden.id, code: 'F', name: 'Other', areaHa: '100' } });
  const otherSeason = await tx.season.create({ data: { organizationId: f.bId, farmId: f.foreign.id, code: 'S', name: 'Other', startDate: new Date('2026-01-01'), expectedEndDate: new Date('2026-12-31') } });
  const otherCrop = await tx.crop.create({ data: { organizationId: f.bId, scope: 'ORGANIZATION', code: 'X', name: 'Other' } });
  for (const [key, id] of [['fieldId', otherField.id], ['seasonId', otherSeason.id], ['cropId', otherCrop.id]]) {
    assert.equal((await post(request, f, { ...data(f), [key]: id })).status, 404);
  }
  assert.equal((await request(`${path(f)}?cropId=${otherCrop.id}`)).body.items.length, 0);
}));

test('plantings HTTP: strict protected fields, decimal limits, dates and bounded filters', () => scenario(async (_tx, f, request) => {
  const created = await post(request, f);
  for (const key of ['id', 'organizationId', 'farmId', 'status', 'actualAreaHa', 'actualStartDate', 'actualEndDate', 'createdAt', 'updatedAt', 'relations']) {
    assert.equal((await post(request, f, { ...data(f), [key]: 'forged' })).status, 400);
    assert.equal((await patch(request, f, created.body.id, { [key]: 'forged' })).status, 400);
  }
  for (const key of ['fieldId', 'seasonId', 'cropId']) assert.equal((await patch(request, f, created.body.id, { [key]: randomUUID() })).status, 400);
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e2', '1.0000001', '1000000000000', 1, null]) {
    assert.equal((await post(request, f, { ...data(f), plannedAreaHa: value })).status, 400);
  }
  for (const value of ['2026-02-30', '0000-01-01', '2026-01-01T00:00:00Z', null]) assert.equal((await post(request, f, { ...data(f), plannedStartDate: value })).status, 400);
  for (const body of [{}, [], { notes: '' }, { variety: 'x'.repeat(161) }, { expectedEndDate: '2025-01-01' }, { spacingMeters: '0' }]) assert.equal((await patch(request, f, created.body.id, body)).status, 400);
  for (const query of ['limit=101', 'limit=0', 'offset=10001', 'organizationId=forged', 'farmId=forged', 'status=UNKNOWN', 'fieldId=invalid', 'limit=1&limit=2']) assert.equal((await request(`${path(f)}?${query}`)).status, 400);
}));

test('plantings HTTP: active parents and planning Season states; historical records remain readable', () => scenario(async (tx, f, request) => {
  const created = await post(request, f);
  for (const [model, id, status] of [['farm', f.farm.id, 'INACTIVE'], ['field', f.field.id, 'INACTIVE'], ['crop', f.crop.id, 'INACTIVE']]) {
    await tx[model].update({ where: { id }, data: { status } });
    assert.equal((await post(request, f)).status, 409);
    assert.equal((await patch(request, f, created.body.id, { notes: 'Denied' })).status, 409);
    assert.equal((await request(`${path(f)}/${created.body.id}`)).status, 200);
    await tx[model].update({ where: { id }, data: { status: 'ACTIVE' } });
  }
  for (const status of ['IN_PROGRESS', 'FINISHED', 'CANCELLED']) {
    await tx.season.update({ where: { id: f.season.id }, data: { status } });
    assert.equal((await post(request, f)).status, status === 'IN_PROGRESS' ? 201 : 409);
  }
  await tx.season.update({ where: { id: f.season.id }, data: { status: 'PLANNED' } });
  await tx.planting.update({ where: { id: created.body.id }, data: { status: 'FINISHED', actualAreaHa: '60', actualStartDate: new Date('2026-01-01'), actualEndDate: new Date('2026-02-01') } });
  assert.equal((await patch(request, f, created.body.id, { notes: 'No' })).status, 409);
  assert.equal((await request(`${path(f)}/${created.body.id}`)).body.actualEndDate, '2026-02-01');
  assert.equal((await request(`${path(f)}/${created.body.id}`, { method: 'DELETE' })).status, 404);
}));

async function waitForBlocked(pid, expected) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const [{ count }] = await db.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
    if (count >= expected) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected writers did not reach the lock');
}
test('plantings HTTP: concurrent partial edits preserve omitted values and parent deactivation is rechecked', async () => {
  let f;
  try {
    f = await db.$transaction(async tx => {
      const fixture = await fixtures(tx, true);
      fixture.field = await tx.field.create({data:{organizationId:fixture.aId,farmId:fixture.farm.id,code:'F',name:'Field',areaHa:'100'}});
      fixture.season = await tx.season.create({data:{organizationId:fixture.aId,farmId:fixture.farm.id,code:'S',name:'Season',startDate:new Date('2026-01-01'),expectedEndDate:new Date('2026-12-31')}});
      fixture.crop = await tx.crop.create({data:{organizationId:fixture.aId,scope:'ORGANIZATION',code:'C',name:'Crop'}});
      return fixture;
    });
    await harness({...delegates(db),$transaction:db.$transaction.bind(db)}, f, async request => {
      const created=await post(request,f); assert.equal(created.status,201);
      let pending=[];
      try {
        await db.$transaction(async blocker=>{
          const [{pid}]=await blocker.$queryRaw`SELECT pg_backend_pid() AS pid`;
          await blocker.$queryRaw`SELECT "id" FROM "Farm" WHERE "id"=${f.farm.id}::uuid FOR UPDATE`;
          pending=[patch(request,f,created.body.id,{notes:'Concurrent notes'}),patch(request,f,created.body.id,{variety:'Concurrent variety'})];
          await waitForBlocked(pid,2);
        });
        for(const result of await Promise.all(pending)) assert.equal(result.status,200);
        const stored=(await request(`${path(f)}/${created.body.id}`)).body;
        assert.equal(stored.notes,'Concurrent notes'); assert.equal(stored.variety,'Concurrent variety');
        await db.$transaction(async blocker=>{
          const [{pid}]=await blocker.$queryRaw`SELECT pg_backend_pid() AS pid`;
          await blocker.crop.update({where:{id:f.crop.id},data:{status:'INACTIVE'}});
          pending=[patch(request,f,created.body.id,{notes:'Denied'})];
          await waitForBlocked(pid,1);
        });
        assert.equal((await pending[0]).status,409);
        assert.equal((await request(`${path(f)}/${created.body.id}`)).body.notes,'Concurrent notes');
      } finally { await Promise.allSettled(pending); }
    });
  } catch(error) {
    if(error?.name==='AssertionError') throw error;
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Planting concurrent test failed safely (${error?.code??error?.name??'unknown'}).`);
  } finally {
    if(f) await db.$transaction(async tx=>{
      const scope={organizationId:{in:[f.aId,f.bId]}};
      await tx.planting.deleteMany({where:scope}); await tx.field.deleteMany({where:scope});
      await tx.season.deleteMany({where:scope}); await tx.crop.deleteMany({where:scope});
      await tx.farmMembership.deleteMany({where:scope}); await tx.farm.deleteMany({where:scope});
      await tx.authSession.deleteMany({where:{userId:f.userId}}); await tx.organizationMembership.deleteMany({where:{userId:f.userId}});
      await tx.rolePermission.deleteMany({where:scope}); await tx.role.deleteMany({where:scope});
      await tx.organization.deleteMany({where:{id:{in:[f.aId,f.bId]}}}); await tx.user.delete({where:{id:f.userId}});
    });
  }
});
