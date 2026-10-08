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
import { FarmsService } from '../dist/farms/farms.service.js';
import { FarmsController } from '../dist/farms/farms.controller.js';
import { configureHttp } from '../dist/http-security.js';
import { provisionSystemRoles } from '../prisma/permissions.mjs';

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
    await tx.rolePermission.createMany({ data: ['farms.read', 'farms.manage'].map(permissionCode => ({ organizationId: aId, roleId: role.id, permissionCode })) });
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
  Module({ controllers: [FarmsController], providers: [
    { provide: PrismaService, useValue: database }, { provide: AuthConfig, useValue: config },
    { provide: PasswordService, useValue: {} }, AuthService, AuthorizationService, PermissionGuard, FarmsService,
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
    await run(request, app.get(FarmsService));
  } finally { await app.close(); }
}
function delegates(tx) {
  return { authSession: tx.authSession, organizationMembership: tx.organizationMembership, farm: tx.farm, field: tx.field, user: tx.user };
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
const patch = (request, id, body) => request(`/farms/${id}`, { method: 'PATCH', body });

test('farms: OWNER creates from trusted tenant, DTO has no internal relations and decimals are strings', () => scenario(async (tx, f, request) => {
  const result = await request('/farms', { method: 'POST', body: { ...input, code: ' new ', country: 'br', legalOwnerName: 'Legal owner', totalAreaHa: '100.123456' } });
  assert.equal(result.status, 201); assert.equal(result.body.code, 'NEW'); assert.equal(result.body.country, 'BR');
  assert.equal(result.body.totalAreaHa, '100.123456'); assert.equal(result.body.status, 'ACTIVE');
  assert.deepEqual(Object.keys(result.body).sort(), ['id', 'code', 'name', 'legalOwnerName', 'locationText', 'municipality', 'state', 'country', 'timezone', 'totalAreaHa', 'productiveAreaHa', 'description', 'status', 'createdAt', 'updatedAt'].sort());
  const stored = await tx.farm.findUnique({ where: { id: result.body.id } }); assert.equal(stored.organizationId, f.aId);
  assert.equal(await tx.farmMembership.count({ where: { farmId: stored.id } }), 0);
}));
test('farms: OWNER lists only own organization including inactive farms; detail never crosses tenant', () => scenario(async (tx, f, request) => {
  await tx.farm.update({ where: { id: f.hidden.id }, data: { status: 'INACTIVE' } });
  const result = await request(); assert.equal(result.status, 200); assert.equal(result.body.items.length, 2);
  assert.deepEqual(result.body.items.map(row => row.id), [f.farm.id, f.hidden.id].sort());
  assert.equal((await request(`/farms/${f.farm.id}`)).status, 200);
  const results = [];
  for (const id of [f.foreign.id, randomUUID(), 'invalid']) results.push(await request(`/farms/${id}`));
  for (const response of results) { assert.equal(response.status, 404); assert.deepEqual(response.body, results[0].body); }
}));
for (const role of ['MANAGER', 'AGRONOMIST']) test(`farms: ${role} sees only active territorial grants; revocation is immediate`, () => scenario(async (tx, f, request) => {
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles[role].id } });
  const result = await request(); assert.deepEqual(result.body.items.map(row => row.id), [f.farm.id]);
  assert.equal((await request(`/farms/${f.hidden.id}`)).status, 404);
  assert.equal((await request(`/farms/${f.foreign.id}`)).status, 404);
  assert.equal((await request('/farms', { method: 'POST', body: input })).status, 403);
  assert.equal((await patch(request, f.farm.id, { name: 'Denied' })).status, 403);
  await tx.farmMembership.update({ where: { id: f.grant.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  assert.equal((await request(`/farms/${f.farm.id}`)).status, 404);
  assert.deepEqual((await request()).body.items, []);
}));
test('farms: WORKER limited capability is not general farm read', () => scenario(async (tx, f, request) => {
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles.WORKER.id } });
  assert.equal((await request()).status, 403); assert.equal((await request(`/farms/${f.farm.id}`)).status, 403);
}));
test('farms: OWNER still needs capabilities; inactive Permission and missing RolePermission deny', () => scenario(async (tx, f, request) => {
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.OWNER.id, permissionCode: 'farms.manage' } } });
  assert.equal((await request('/farms', { method: 'POST', body: input })).status, 403);
  assert.equal((await patch(request, f.farm.id, { name: 'Denied' })).status, 403);
  await tx.permission.update({ where: { code: 'farms.read' }, data: { status: 'INACTIVE' } });
  assert.equal((await request()).status, 403);
}));
test('farms: non-OWNER with manage capability still cannot PATCH invisible farms or gain access on create', () => scenario(async (tx, f, request) => {
  await tx.rolePermission.create({ data: { organizationId: f.aId, roleId: f.roles.MANAGER.id, permissionCode: 'farms.manage' } });
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles.MANAGER.id } });
  assert.equal((await patch(request, f.farm.id, { name: 'Allowed' })).status, 200);
  for (const id of [f.hidden.id, f.foreign.id, randomUUID()]) assert.equal((await patch(request, id, { name: 'Denied' })).status, 404);
  const created = await request('/farms', { method: 'POST', body: input }); assert.equal(created.status, 201);
  assert.equal((await request(`/farms/${created.body.id}`)).status, 404);
}));
test('farms: no authentication 401; invalid or inactive membership context 403', () => scenario(async (tx, f, request) => {
  assert.equal((await request('/farms', { token: '' })).status, 401);
  assert.equal((await request('/farms', { membership: randomUUID() })).status, 403);
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { status: 'SUSPENDED' } });
  assert.equal((await request()).status, 403);
}));
test('farms: body allowlist prevents mass assignment and rejects invalid structures', () => scenario(async (_tx, f, request) => {
  for (const field of ['organizationId', 'id', 'createdAt', 'updatedAt', 'memberships', 'status', 'unknown']) {
    assert.equal((await request('/farms', { method: 'POST', body: { ...input, [field]: 'forged' } })).status, 400);
  }
  for (const body of [null, [], {}, { name: null }, { organizationId: f.bId }, { fields: [] }]) {
    assert.equal((await patch(request, f.farm.id, body)).status, 400);
  }
}));
test('farms: decimals reject floats, overflow, exponent, excess precision and invalid areas', () => scenario(async (_tx, f, request) => {
  for (const value of [100, '1e2', 'NaN', '-1', '1000000000000', '1.0000001', '01', ' 1', '0']) {
    assert.equal((await request('/farms', { method: 'POST', body: { ...input, totalAreaHa: value } })).status, 400);
  }
  assert.equal((await request('/farms', { method: 'POST', body: { ...input, productiveAreaHa: '101' } })).status, 400);
  assert.equal((await patch(request, f.farm.id, { totalAreaHa: '70' })).status, 400);
  assert.equal((await patch(request, f.farm.id, { productiveAreaHa: '101' })).status, 400);
  const valid = await patch(request, f.farm.id, { totalAreaHa: '90.123456', productiveAreaHa: '0' });
  assert.equal(valid.status, 200); assert.equal(valid.body.productiveAreaHa, '0');
}));
test('farms: validates text, timezone and country with no arbitrary defaults', () => scenario(async (_tx, _f, request) => {
  for (const body of [{ ...input, name: ' ' }, { ...input, code: 'X\n' }, { ...input, country: 'BRA' }, { ...input, timezone: 'Not/AZone' }, { ...input, municipality: null }, { ...input, description: 'x'.repeat(2001) }]) {
    assert.equal((await request('/farms', { method: 'POST', body })).status, 400);
  }
}));
test('farms: normalized code uniqueness yields safe 409 only within tenant', () => scenario(async (_tx, f, request) => {
  assert.equal((await request('/farms', { method: 'POST', body: { ...input, code: ' a1 ' } })).status, 409);
  assert.equal((await request('/farms', { method: 'POST', body: { ...input, code: f.foreign.code } })).status, 201);
  const result = await patch(request, f.hidden.id, { code: f.farm.code });
  assert.equal(result.status, 409); assert.equal(JSON.stringify(result.body).includes('Prisma'), false);
}));
test('farms: pagination is stable, bounded and rejects unknown tenant filters', () => scenario(async (_tx, f, request) => {
  const first = await request('/farms?limit=1'); assert.equal(first.body.items.length, 1); assert.equal(first.body.hasMore, true);
  const second = await request('/farms?limit=1&offset=1'); assert.equal(second.body.hasMore, false); assert.notEqual(first.body.items[0].id, second.body.items[0].id);
  for (const query of ['limit=0', 'limit=101', 'offset=10001', 'limit=1&limit=2', 'organizationId=other', 'status=ACTIVE', 'offset=-1']) assert.equal((await request(`/farms?${query}`)).status, 400);
  assert.equal((await request(`/farms/${f.farm.id}?organizationId=${f.bId}`)).status, 400);
}));
test('farms: inactivation preserves children/grants and partial patch preserves omitted fields', () => scenario(async (tx, f, request) => {
  await tx.field.create({ data: { organizationId: f.aId, farmId: f.farm.id, code: 'F1', name: 'Field', areaHa: '90' } });
  const result = await patch(request, f.farm.id, { status: 'INACTIVE', description: 'History' });
  assert.equal(result.status, 200); assert.equal(result.body.code, f.farm.code);
  assert.equal(await tx.field.count({ where: { farmId: f.farm.id } }), 1);
  assert.equal(await tx.farmMembership.count({ where: { farmId: f.farm.id } }), 1);
  assert.equal((await patch(request, f.farm.id, { totalAreaHa: '85' })).status, 409);
  assert.equal((await patch(request, f.farm.id, { status: 'ACTIVE', description: null })).status, 200);
}));
test('farms: CORS allows PATCH preflight only for configured origin', () => scenario(async (_tx, f, request) => {
  const response = await request(`/farms/${f.farm.id}`, { method: 'OPTIONS', token: '', membership: '', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'authorization,x-organization-membership-id,content-type' } });
  assert.equal(response.status, 204); assert.ok(response.headers.get('access-control-allow-methods').includes('PATCH'));
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const hostile = await request('/farms', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PATCH' } });
  assert.equal(hostile.headers.get('access-control-allow-origin'), null);
}));

test('farms: concurrent partial PATCH requests preserve independent fields and merge areas after row lock', async () => {
  let f;
  try {
    f = await db.$transaction(tx => fixtures(tx, true));
    // No lifecycle hooks: production queries and independent real transactions.
    await harness({ ...delegates(db), $transaction: db.$transaction.bind(db) }, f, async request => {
      const race = async bodies => {
        let requests;
        await db.$transaction(async blocker => {
          const [{ pid }] = await blocker.$queryRaw`SELECT pg_backend_pid() AS pid`;
          await blocker.$queryRaw`SELECT "id" FROM "Farm" WHERE "id" = ${f.farm.id}::uuid AND "organizationId" = ${f.aId}::uuid FOR UPDATE`;
          requests = bodies.map(body => patch(request, f.farm.id, body));
          // Observe both real database waiters before releasing the held row.
          const deadline = Date.now() + 2000;
          let blocked;
          do {
            const [state] = await db.$queryRaw`WITH RECURSIVE waiting AS (
              SELECT activity.pid FROM pg_stat_activity activity WHERE ${pid}::int = ANY(pg_blocking_pids(activity.pid))
              UNION
              SELECT activity.pid FROM pg_stat_activity activity JOIN waiting ON waiting.pid = ANY(pg_blocking_pids(activity.pid))
            ) SELECT count(*)::int AS blocked FROM waiting`;
            blocked = state.blocked;
            if (blocked < 2) await delay(15);
          } while (blocked < 2 && Date.now() < deadline);
          assert.equal(blocked, 2, 'Both PATCH transactions must wait for the same Farm lock');
        });
        return Promise.all(requests);
      };
      const results = await race([{ name: 'Concurrent name' }, { description: 'Concurrent description' }]);
      for (const result of results) assert.equal(result.status, 200);
      const stored = await db.farm.findUnique({ where: { id: f.farm.id } });
      assert.equal(stored.name, 'Concurrent name'); assert.equal(stored.description, 'Concurrent description');
      const areas = await race([{ totalAreaHa: '85' }, { productiveAreaHa: '95' }]);
      assert.deepEqual(areas.map(result => result.status).sort(), [200, 400]);
      const final = await db.farm.findUnique({ where: { id: f.farm.id } }); assert.ok(final.productiveAreaHa.lte(final.totalAreaHa));
    });
  } catch (error) {
    if (error?.name === 'AssertionError') throw error;
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Concurrent farms test failed safely (${error?.code ?? error?.name ?? 'unknown'}).`);
  } finally {
    if (f) await db.$transaction(async tx => {
      await tx.farmMembership.deleteMany({ where: { organizationId: { in: [f.aId, f.bId] } } });
      await tx.farm.deleteMany({ where: { organizationId: { in: [f.aId, f.bId] } } });
      await tx.authSession.deleteMany({ where: { userId: f.userId } });
      await tx.organizationMembership.deleteMany({ where: { userId: f.userId } });
      await tx.rolePermission.deleteMany({ where: { organizationId: f.aId } });
      await tx.role.deleteMany({ where: { organizationId: f.aId } });
      await tx.organization.deleteMany({ where: { id: { in: [f.aId, f.bId] } } });
      await tx.user.delete({ where: { id: f.userId } });
    });
  }
});
