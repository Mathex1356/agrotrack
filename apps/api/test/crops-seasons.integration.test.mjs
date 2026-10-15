import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

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
import { CropsService } from '../dist/crops/crops.service.js';
import { SeasonsService } from '../dist/seasons/seasons.service.js';
import { CropsController } from '../dist/crops/crops.controller.js';
import { SeasonsController } from '../dist/seasons/seasons.controller.js';
import { configureHttp } from '../dist/http-security.js';
import { provisionSystemRoles, seedPermissions, systemRolePermissions } from '../prisma/permissions.mjs';

let db, config;
const rollback = new Error('Rollback farm fixtures');
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
    await tx.rolePermission.createMany({ data: ['farms.read', 'seasons.manage', 'crops.read', 'crops.manage'].map(permissionCode => ({ organizationId: aId, roleId: role.id, permissionCode })) });
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
  Module({ controllers: [CropsController, SeasonsController], providers: [
    { provide: PrismaService, useValue: database }, { provide: AuthConfig, useValue: config },
    { provide: PasswordService, useValue: {} }, AuthService, AuthorizationService, PermissionGuard, CropsService, SeasonsService,
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
    await run(request, app.get(CropsService));
  } finally { await app.close(); }
}
function delegates(tx) {
  return { authSession: tx.authSession, organizationMembership: tx.organizationMembership, farm: tx.farm, field: tx.field, crop: tx.crop, season: tx.season, user: tx.user };
}
async function scenario(run) {
  try {
    await db.$transaction(async tx => {
      const f = await fixtures(tx);
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
const seasonInput = { code: 'S1', name: 'Season', startDate: '2026-01-01', expectedEndDate: '2026-12-31' };
const seasonPath = f => `/farms/${f.farm.id}/seasons`;
const post = (request, path, body) => request(path, { method: 'POST', body });
const patch = (request, path, body) => request(path, { method: 'PATCH', body });

test('catalog APIs: private crop CRUD projection, normalization, global read-only and tenant isolation', () => scenario(async (tx, f, request) => {
  const created = await post(request, '/crops', { code: ' custom ', name: 'Custom' });
  assert.equal(created.status, 201); assert.equal(created.body.code, 'CUSTOM'); assert.equal(created.body.scope, 'ORGANIZATION');
  assert.equal('organizationId' in created.body, false);
  const row = await tx.crop.findUnique({ where: { id: created.body.id } }); assert.equal(row.organizationId, f.aId);
  const global = await tx.crop.findFirstOrThrow({ where: { scope: 'GLOBAL' } });
  assert.equal((await request(`/crops/${global.id}`)).status, 200);
  assert.equal((await patch(request, `/crops/${global.id}`, { name: 'Forbidden' })).status, 404);
  const foreign = await tx.crop.create({ data: { scope: 'ORGANIZATION', organizationId: f.bId, code: 'CUSTOM', name: 'Foreign' } });
  for (const id of [foreign.id, randomUUID(), 'invalid']) {
    assert.equal((await request(`/crops/${id}`)).status, 404);
    assert.equal((await patch(request, `/crops/${id}`, { name: 'No' })).status, 404);
  }
  const updated = await patch(request, `/crops/${row.id}`, { status: 'INACTIVE' });
  assert.equal(updated.status, 200); assert.equal(updated.body.name, 'Custom'); assert.equal(updated.body.status, 'INACTIVE');
  assert.equal((await post(request, '/crops', { code: 'custom', name: 'Duplicate' })).status, 409);
  const list = await request('/crops?limit=100'); assert.equal(list.status, 200);
  assert.ok(list.body.items.some(item => item.id === global.id)); assert.ok(list.body.items.some(item => item.id === row.id));
  assert.ok(!list.body.items.some(item => item.id === foreign.id));
}));

for (const role of ['MANAGER', 'AGRONOMIST', 'WORKER']) test(`catalog APIs: ${role} capability and territory separation`, () => scenario(async (tx, f, request) => {
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles[role].id } });
  assert.equal((await request('/crops')).status, role === 'WORKER' ? 403 : 200);
  assert.equal((await post(request, '/crops', { code: 'X', name: 'Denied' })).status, 403);
  assert.equal((await post(request, seasonPath(f), seasonInput)).status, role === 'WORKER' ? 403 : 201);
  assert.equal((await request(`/farms/${f.hidden.id}/seasons`)).status, role === 'WORKER' ? 403 : 404);
  await tx.farmMembership.update({ where: { id: f.grant.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  assert.equal((await request(seasonPath(f))).status, role === 'WORKER' ? 403 : 404);
  assert.equal((await request('/crops')).status, role === 'WORKER' ? 403 : 200);
}));

test('catalog APIs: identity, inactive context and removed capabilities deny with the same token', () => scenario(async (tx, f, request) => {
  assert.equal((await request('/crops', { token: '' })).status, 401);
  assert.equal((await request('/crops', { membership: randomUUID() })).status, 403);
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.OWNER.id, permissionCode: 'crops.manage' } } });
  assert.equal((await post(request, '/crops', { code: 'X', name: 'No' })).status, 403);
  await tx.permission.update({ where: { code: 'crops.read' }, data: { status: 'INACTIVE' } });
  assert.equal((await request('/crops')).status, 403);
  await tx.organization.update({ where: { id: f.aId }, data: { status: 'SUSPENDED' } });
  assert.equal((await request(seasonPath(f))).status, 403);
}));

test('catalog APIs: strict allowlists, protected properties and bounded pagination', () => scenario(async (_tx, f, request) => {
  const crop = await post(request, '/crops', { code: 'X', name: 'Crop' });
  for (const key of ['id', 'organizationId', 'scope', 'status', 'createdAt', 'plantings']) {
    assert.equal((await post(request, '/crops', { code: 'Y', name: 'Crop', [key]: 'forged' })).status, 400);
  }
  for (const body of [{ scope: 'GLOBAL' }, { organizationId: f.bId }, { code: ' ' }, { name: null }, {}, [], { status: 'UNKNOWN' }]) {
    assert.equal((await patch(request, `/crops/${crop.body.id}`, body)).status, 400);
  }
  for (const key of ['organizationId', 'farmId', 'status', 'actualEndDate', 'id', 'plantings']) {
    assert.equal((await post(request, seasonPath(f), { ...seasonInput, [key]: 'forged' })).status, 400);
  }
  for (const path of ['/crops', seasonPath(f)]) {
    for (const query of ['limit=0', 'limit=101', 'offset=10001', 'organizationId=forged', 'status=ACTIVE', 'limit=1&limit=2']) {
      assert.equal((await request(`${path}?${query}`)).status, 400);
    }
  }
  const first = await request('/crops?limit=1'); const second = await request('/crops?limit=1&offset=1');
  assert.equal(first.body.hasMore, true); assert.notEqual(first.body.items[0].id, second.body.items[0].id);
}));

test('seasons: civil dates, overlapping cycles, unique farm codes and recombined PATCH dates', () => scenario(async (_tx, f, request) => {
  for (const value of ['2026-02-30', '1900-02-29', '0000-01-01', '2026-01-01T00:00:00Z', 2026, null]) {
    assert.equal((await post(request, seasonPath(f), { ...seasonInput, startDate: value })).status, 400);
  }
  const leap = await post(request, seasonPath(f), { ...seasonInput, startDate: '2000-02-29' });
  assert.equal(leap.status, 201); assert.equal(leap.body.startDate, '2000-02-29'); assert.equal(leap.body.status, 'PLANNED');
  assert.equal(leap.body.actualEndDate, null); assert.equal('organizationId' in leap.body, false);
  assert.equal((await post(request, seasonPath(f), { ...seasonInput, code: 'S2' })).status, 201);
  assert.equal((await post(request, seasonPath(f), seasonInput)).status, 409);
  assert.equal((await post(request, `/farms/${f.hidden.id}/seasons`, seasonInput)).status, 201);
  assert.equal((await patch(request, `${seasonPath(f)}/${leap.body.id}`, { expectedEndDate: '1999-12-31' })).status, 400);
  assert.equal((await patch(request, `${seasonPath(f)}/${leap.body.id}`, { startDate: '2027-01-01' })).status, 400);
  const changed = await patch(request, `${seasonPath(f)}/${leap.body.id}`, { name: 'Updated' });
  assert.equal(changed.status, 200); assert.equal(changed.body.startDate, '2000-02-29');
  for (const body of [{ status: 'IN_PROGRESS' }, { actualEndDate: '2026-12-31' }]) assert.equal((await patch(request, `${seasonPath(f)}/${leap.body.id}`, body)).status, 400);
}));

test('seasons: scoped 404, historic states readable but not editable, inactive farm writes denied', () => scenario(async (tx, f, request) => {
  const created = await post(request, seasonPath(f), seasonInput);
  for (const farmId of [f.foreign.id, randomUUID(), 'invalid']) {
    assert.equal((await request(`/farms/${farmId}/seasons`)).status, 404);
    assert.equal((await request(`/farms/${farmId}/seasons/${created.body.id}`)).status, 404);
  }
  assert.equal((await request(`/farms/${f.hidden.id}/seasons/${created.body.id}`)).status, 404);
  for (const status of ['IN_PROGRESS', 'FINISHED', 'CANCELLED']) {
    await tx.season.update({ where: { id: created.body.id }, data: { status } });
    assert.equal((await request(`${seasonPath(f)}/${created.body.id}`)).status, 200);
    assert.equal((await patch(request, `${seasonPath(f)}/${created.body.id}`, { name: 'No' })).status, 409);
  }
  await tx.farm.update({ where: { id: f.farm.id }, data: { status: 'INACTIVE' } });
  assert.equal((await request(seasonPath(f))).status, 200);
  assert.equal((await post(request, seasonPath(f), { ...seasonInput, code: 'NEW' })).status, 409);
}));

test('catalog APIs: preserve Planting references and validate legacy actualEndDate on partial edit', () => scenario(async (tx, f, request) => {
  const crop = await post(request, '/crops', { code: 'HISTORY', name: 'History' });
  const season = await post(request, seasonPath(f), seasonInput);
  const field = await tx.field.create({ data: { organizationId: f.aId, farmId: f.farm.id, code: 'H', name: 'History', areaHa: '10' } });
  const planting = await tx.planting.create({ data: { organizationId: f.aId, farmId: f.farm.id, fieldId: field.id,
    seasonId: season.body.id, cropId: crop.body.id, plannedAreaHa: '5', plannedStartDate: new Date('2026-02-01') } });
  assert.equal((await patch(request, `/crops/${crop.body.id}`, { status: 'INACTIVE' })).status, 200);
  assert.equal((await patch(request, `${seasonPath(f)}/${season.body.id}`, { name: 'Renamed' })).status, 200);
  assert.equal(await tx.planting.count({ where: { id: planting.id } }), 1);
  await tx.season.update({ where: { id: season.body.id }, data: { actualEndDate: new Date('2026-03-01') } });
  assert.equal((await patch(request, `${seasonPath(f)}/${season.body.id}`, { startDate: '2026-04-01' })).status, 400);
  const stored = await tx.season.findUnique({ where: { id: season.body.id } });
  assert.equal(stored.startDate.toISOString().slice(0, 10), '2026-01-01');
}));

test('permission introduction: atomic defaults, preservation of custom grants and removed capabilities', () => scenario(async (tx, f) => {
  // Simulate the pre-upgrade catalogue inside rollback; no persisted catalogue deletion.
  const codes = ['crops.read', 'crops.manage'];
  await tx.rolePermission.deleteMany({ where: { permissionCode: { in: codes } } });
  await tx.permission.deleteMany({ where: { code: { in: codes } } });
  const custom = await tx.role.create({ data: { organizationId: f.aId, name: 'Custom role' } });
  await tx.rolePermission.create({ data: { organizationId: f.aId, roleId: custom.id, permissionCode: 'farms.read' } });
  await tx.rolePermission.create({ data: { organizationId: f.aId, roleId: f.roles.MANAGER.id, permissionCode: 'audit.read' } });
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.MANAGER.id, permissionCode: 'farms.read' } } });
  await tx.$executeRawUnsafe('SAVEPOINT introduction');
  await seedPermissions(tx);
  assert.equal(await tx.permission.count({ where: { code: { in: codes } } }), 2);
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT introduction');
  await tx.$executeRawUnsafe('RELEASE SAVEPOINT introduction');
  assert.equal(await tx.permission.count({ where: { code: { in: codes } } }), 0);
  await seedPermissions(tx);
  for (const [role, expected] of [
    ['OWNER', ['crops.manage', 'crops.read']], ['MANAGER', ['crops.read']],
    ['AGRONOMIST', ['crops.read']], ['WORKER', []],
  ]) {
    const grants = await tx.rolePermission.findMany({
      where: { roleId: f.roles[role].id, permissionCode: { in: codes } },
      select: { permissionCode: true }, orderBy: { permissionCode: 'asc' },
    });
    assert.deepEqual(grants.map(grant => grant.permissionCode), expected, role);
  }
  assert.equal(await tx.rolePermission.count({ where: { roleId: custom.id, permissionCode: { in: codes } } }), 0);
  const snapshot = () => tx.rolePermission.findMany({
    where: { organizationId: f.aId },
    select: { organizationId: true, roleId: true, permissionCode: true },
    orderBy: [{ roleId: 'asc' }, { permissionCode: 'asc' }],
  });
  const introduced = await snapshot();
  for (let run = 0; run < 2; run++) {
    await seedPermissions(tx); await provisionSystemRoles(tx, f.aId);
    assert.deepEqual(await snapshot(), introduced);
  }
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.MANAGER.id, permissionCode: 'crops.read' } } });
  const customized = await snapshot();
  await seedPermissions(tx); await provisionSystemRoles(tx, f.aId);
  assert.deepEqual(await snapshot(), customized);
  const manager = (await tx.rolePermission.findMany({ where: { roleId: f.roles.MANAGER.id } })).map(row => row.permissionCode);
  assert.ok(!manager.includes('crops.read')); assert.ok(!manager.includes('farms.read')); assert.ok(manager.includes('audit.read'));
  assert.deepEqual((await tx.rolePermission.findMany({ where: { roleId: custom.id } })).map(row => row.permissionCode), ['farms.read']);
  await provisionSystemRoles(tx, f.bId);
  const owner = await tx.role.findFirstOrThrow({ where: { organizationId: f.bId, systemCode: 'OWNER' } });
  assert.equal(await tx.rolePermission.count({ where: { roleId: owner.id } }), systemRolePermissions.OWNER.length);
}));

async function waitForBlocked(pid, expected, target = null) {
  const deadline = Date.now() + 2000;
  let blocked;
  do {
    const [state] = await db.$queryRaw`WITH RECURSIVE waiting AS (
      SELECT activity.pid FROM pg_stat_activity activity WHERE ${pid}::int = ANY(pg_blocking_pids(activity.pid))
      UNION SELECT activity.pid FROM pg_stat_activity activity JOIN waiting ON waiting.pid = ANY(pg_blocking_pids(activity.pid))
    ) SELECT count(*)::int AS blocked FROM waiting WHERE ${target}::int IS NULL OR pid = ${target}::int`;
    blocked = state.blocked;
    if (blocked < expected) await delay(15);
  } while (blocked < expected && Date.now() < deadline);
  assert.equal(blocked, expected, 'Expected concurrent database lock waiters');
}

for (const first of ['seed', 'provision']) test(`permissions: shared lock serializes ${first} before concurrent peer`, async () => {
  let pending;
  try {
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(7700317)`;
      const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      const organization = await tx.organization.create({ data: { name: 'Concurrent', referenceCode: randomUUID().toUpperCase() } });
      if (first === 'seed') await seedPermissions(tx); else await provisionSystemRoles(tx, organization.id);
      const ready = Promise.withResolvers();
      pending = db.$transaction(async peer => {
        const [{ pid: peerPid }] = await peer.$queryRaw`SELECT pg_backend_pid() AS pid`;
        ready.resolve(peerPid);
        const other = await peer.organization.create({ data: { name: 'Concurrent peer', referenceCode: randomUUID().toUpperCase() } });
        if (first === 'seed') await provisionSystemRoles(peer, other.id); else await seedPermissions(peer);
        if (first === 'seed') {
          const owner = await peer.role.findFirstOrThrow({ where: { organizationId: other.id, systemCode: 'OWNER' } });
          assert.equal(await peer.rolePermission.count({ where: { roleId: owner.id } }), systemRolePermissions.OWNER.length);
        }
        throw rollback;
      }, { timeout: 15000 }).catch(error => { if (error !== rollback) throw error; });
      await waitForBlocked(pid, 1, await ready.promise);
      throw rollback;
    }, { timeout: 15000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally { if (pending) await pending; }
});

test('catalog APIs: real concurrent unique conflicts and partial edits preserve omitted values', async () => {
  let f;
  try {
    f = await db.$transaction(tx => fixtures(tx, true));
    await harness({ ...delegates(db), $transaction: db.$transaction.bind(db) }, f, async request => {
      for (const [path, body] of [['/crops', { code: 'RACE', name: 'Race' }], [seasonPath(f), seasonInput]]) {
        const responses = await Promise.all([post(request, path, body), post(request, path, body)]);
        assert.deepEqual(responses.map(row => row.status).sort(), [201, 409]);
        const created = responses.find(row => row.status === 201).body;
        let requests;
        try {
          await db.$transaction(async blocker => {
            const [{ pid }] = await blocker.$queryRaw`SELECT pg_backend_pid() AS pid`;
            if (path === '/crops') await blocker.$queryRaw`SELECT "id" FROM "Crop" WHERE "id"=${created.id}::uuid FOR UPDATE`;
            else await blocker.$queryRaw`SELECT "id" FROM "Farm" WHERE "id"=${f.farm.id}::uuid FOR UPDATE`;
            requests = [patch(request, `${path}/${created.id}`, { name: 'Concurrent name' }), patch(request, `${path}/${created.id}`, { code: 'CHANGED' })];
            await waitForBlocked(pid, 2);
          });
          for (const response of await Promise.all(requests)) assert.equal(response.status, 200);
        } finally { if (requests) await Promise.allSettled(requests); }
        const final = await request(`${path}/${created.id}`);
        assert.equal(final.body.name, 'Concurrent name'); assert.equal(final.body.code, 'CHANGED');
      }
    });
  } catch (error) {
    if (error?.name === 'AssertionError') throw error;
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Concurrent catalog test failed safely (${error?.code ?? error?.name ?? 'unknown'}).`);
  } finally {
    if (f) await db.$transaction(async tx => {
      const scope = { organizationId: { in: [f.aId, f.bId] } };
      await tx.season.deleteMany({ where: scope }); await tx.crop.deleteMany({ where: scope });
      await tx.farmMembership.deleteMany({ where: scope }); await tx.farm.deleteMany({ where: scope });
      await tx.authSession.deleteMany({ where: { userId: f.userId } });
      await tx.organizationMembership.deleteMany({ where: { userId: f.userId } });
      await tx.rolePermission.deleteMany({ where: scope }); await tx.role.deleteMany({ where: scope });
      await tx.organization.deleteMany({ where: { id: { in: [f.aId, f.bId] } } }); await tx.user.delete({ where: { id: f.userId } });
    });
  }
});
