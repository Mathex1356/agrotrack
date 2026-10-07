import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Controller, Get, Inject, Module, Param, UseGuards } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { SignJWT } from 'jose';
import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { AuthGuard } from '../dist/auth/auth.guard.js';
import { AuthConfig } from '../dist/auth/auth.config.js';
import { PasswordService } from '../dist/auth/password.service.js';
import { CurrentContext, Public, RequireOrganization } from '../dist/auth/auth.decorators.js';
import { AuthorizationService } from '../dist/authorization/authorization.service.js';
import { PermissionGuard } from '../dist/authorization/permission.guard.js';
import { RequirePermission } from '../dist/authorization/authorization.decorators.js';
import { PERMISSIONS } from '../dist/authorization/permissions.js';
import { SafeExceptionFilter } from '../dist/http-security.js';
import { permissions, provisionSystemRoles } from '../prisma/permissions.mjs';

let db, config;
const rollback = new Error('Rollback authorization fixture');
before(async () => {
  loadEnvironment();
  process.env.NODE_ENV = 'test';
  process.env.AUTH_JWT_SECRET = randomBytes(32).toString('base64url');
  process.env.AUTH_RATE_LIMIT_SECRET = randomBytes(32).toString('base64url');
  process.env.AUTH_ALLOWED_ORIGINS = 'http://localhost:5173';
  config = new AuthConfig();
  db = new PrismaService();
  await db.onModuleInit();
});
after(async () => { await db?.$disconnect(); });

function decorate(target, method, decorator) {
  decorator(target.prototype, method, Object.getOwnPropertyDescriptor(target.prototype, method));
}

// These controllers exist ONLY in this test module, never in the production AppModule.
class Probe {
  constructor(authorization) { this.authorization = authorization; }
  read() { return { allowed: true }; }
  empty() { return { allowed: true }; }
  unknown() { return { allowed: true }; }
  missing() { return { allowed: true }; }
  publicPermission() { return { allowed: true }; }
  farm(context, farmId) { return this.authorization.requireFarmPermission(context, farmId, PERMISSIONS.INVENTORY_CONSUME_VIA_ACTIVITY).then(() => ({ allowed: true })); }
}
Controller('probe')(Probe);
Inject(AuthorizationService)(Probe, undefined, 0);
for (const method of ['read', 'empty', 'unknown', 'missing', 'publicPermission', 'farm']) decorate(Probe, method, Get(method === 'farm' ? 'farm/:farmId' : method));
decorate(Probe, 'read', RequirePermission(PERMISSIONS.FARMS_READ));
decorate(Probe, 'empty', RequirePermission());
decorate(Probe, 'unknown', RequirePermission('not.a.permission'));
decorate(Probe, 'missing', RequireOrganization());
decorate(Probe, 'missing', UseGuards(PermissionGuard));
decorate(Probe, 'publicPermission', Public());
decorate(Probe, 'publicPermission', RequirePermission(PERMISSIONS.FARMS_READ));
decorate(Probe, 'farm', RequireOrganization());
CurrentContext()(Probe.prototype, 'farm', 0);
Param('farmId')(Probe.prototype, 'farm', 1);

class CombinedProbe {
  combined() { return { allowed: true }; }
  repeated() { return { allowed: true }; }
  emptyRepeated() { return { allowed: true }; }
}
Controller('combined')(CombinedProbe);
RequirePermission(PERMISSIONS.FARMS_READ)(CombinedProbe);
for (const method of ['combined', 'repeated', 'emptyRepeated']) decorate(CombinedProbe, method, Get(method));
decorate(CombinedProbe, 'combined', RequirePermission(PERMISSIONS.FIELDS_MANAGE));
decorate(CombinedProbe, 'repeated', RequirePermission(PERMISSIONS.FIELDS_MANAGE));
decorate(CombinedProbe, 'repeated', RequirePermission(PERMISSIONS.ORGANIZATION_MANAGE));
decorate(CombinedProbe, 'emptyRepeated', RequirePermission());
decorate(CombinedProbe, 'emptyRepeated', RequirePermission(PERMISSIONS.FARMS_READ));

async function fixture(tx) {
  const tag = randomUUID();
  const user = await tx.user.create({ data: { displayName: 'Authorization test', email: `${tag}@example.test`, normalizedEmail: `${tag}@example.test` } });
  const other = await tx.user.create({ data: { displayName: 'Other', email: `other-${tag}@example.test`, normalizedEmail: `other-${tag}@example.test` } });
  const organizations = [];
  for (const suffix of ['A', 'B']) organizations.push(await tx.organization.create({ data: { name: 'Authorization test', referenceCode: `${tag}-${suffix}`.toUpperCase(), status: 'ACTIVE' } }));
  const [a, b] = organizations;
  await provisionSystemRoles(tx, a.id);
  const roles = Object.fromEntries((await tx.role.findMany({ where: { organizationId: a.id } })).map(role => [role.systemCode, role]));
  roles.CUSTOM = await tx.role.create({ data: { organizationId: a.id, name: 'Custom test' } });
  const member = await tx.organizationMembership.create({ data: { organizationId: a.id, userId: user.id, roleId: roles.MANAGER.id } });
  const foreignRole = await tx.role.create({ data: { organizationId: b.id, name: 'Foreign' } });
  const foreignMember = await tx.organizationMembership.create({ data: { organizationId: b.id, userId: other.id, roleId: foreignRole.id } });
  const farms = [];
  for (const organization of organizations) farms.push(await tx.farm.create({ data: { organizationId: organization.id, code: 'F1', name: 'Farm test', municipality: 'Test', state: 'SP', country: 'BR', timezone: 'America/Sao_Paulo', totalAreaHa: '100', productiveAreaHa: '90' } }));
  const [farm, foreignFarm] = farms;
  const grant = await tx.farmMembership.create({ data: { organizationId: a.id, organizationMembershipId: member.id, farmId: farm.id } });
  await tx.farmMembership.create({ data: { organizationId: b.id, organizationMembershipId: foreignMember.id, farmId: foreignFarm.id } });
  const session = await tx.authSession.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 600000) } });
  const token = await new SignJWT({ sid: session.id }).setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setSubject(user.id).setIssuer(config.issuer).setAudience(config.audience).setIssuedAt().setExpirationTime('5m').sign(config.jwtKey);
  const context = { userId: user.id, sessionId: session.id, organizationId: a.id, membershipId: member.id, roleId: roles.MANAGER.id };
  return { user, other, a, b, roles, member, foreignMember, farm, foreignFarm, grant, session, token, context };
}

async function scenario(run) {
  try {
    await db.$transaction(async tx => {
      const f = await fixture(tx);
      // PrismaService's transaction proxy inherits lifecycle hooks whose $connect/
      // $disconnect are unavailable in a transaction. Expose real delegates only.
      const transactionalDatabase = {
        authSession: tx.authSession, organizationMembership: tx.organizationMembership,
        farm: tx.farm, user: tx.user,
      };
      class Harness {}
      Module({ controllers: [Probe, CombinedProbe], providers: [
        { provide: PrismaService, useValue: transactionalDatabase }, { provide: AuthConfig, useValue: config },
        // Login is not used here; the actual JWT validator and session/context queries are.
        { provide: PasswordService, useValue: {} }, AuthService, AuthorizationService, PermissionGuard,
        { provide: APP_GUARD, useClass: AuthGuard },
      ] })(Harness);
      const app = await NestFactory.create(Harness, { logger: false, abortOnError: false });
      app.useGlobalFilters(new SafeExceptionFilter());
      try {
        await app.listen(0, '127.0.0.1');
        const base = await app.getUrl();
        const request = async (path = '/probe/read', { token = f.token, membership = f.member.id } = {}) => {
          const response = await fetch(`${base}${path}`, { headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(membership ? { 'X-Organization-Membership-Id': membership } : {}),
          } });
          return { status: response.status, body: await response.json() };
        };
        await run(tx, f, app.get(AuthorizationService), request);
      } finally { await app.close(); }
      throw rollback;
    }, { timeout: 20000 });
  } catch (error) {
    if (error === rollback) return;
    if (error?.name === 'AssertionError') throw error;
    // Original Prisma causes may contain credentials or fixture token material.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Authorization fixture/check failed safely (${error?.code ?? error?.name ?? 'unknown'}).`);
  }
}
const denied = operation => assert.rejects(operation, error => error?.getStatus?.() === 403);
const unauthenticated = operation => assert.rejects(operation, error => error?.getStatus?.() === 401);

test('authorization: typed catalogue matches all 25 seeded capabilities', () => {
  assert.equal(Object.keys(PERMISSIONS).length, 25);
  assert.deepEqual(Object.values(PERMISSIONS).sort(), permissions.map(p => p.code).sort());
});
test('authorization: capability allows; missing, empty and unknown capabilities deny', () => scenario(async (_tx, f, service, request) => {
  assert.equal((await request()).status, 200);
  await denied(() => service.requirePermission(f.context, PERMISSIONS.ORGANIZATION_MANAGE));
  await denied(() => service.requirePermission(f.context, 'not.a.permission'));
  await denied(() => service.requirePermissions(f.context, []));
  for (const path of ['/probe/unknown', '/probe/empty', '/probe/missing']) assert.equal((await request(path)).status, 403);
}));
test('authorization: inactive Permission denies with the same access token', () => scenario(async (tx, _f, _service, request) => {
  assert.equal((await request()).status, 200);
  await tx.permission.update({ where: { code: PERMISSIONS.FARMS_READ }, data: { status: 'INACTIVE' } });
  assert.equal((await request()).status, 403);
}));
test('authorization: removing RolePermission takes effect immediately', () => scenario(async (tx, f, _service, request) => {
  assert.equal((await request()).status, 200);
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.MANAGER.id, permissionCode: PERMISSIONS.FARMS_READ } } });
  assert.equal((await request()).status, 403);
}));
test('authorization: changed Role and inactive custom Role deny without replacing JWT', () => scenario(async (tx, f, service, request) => {
  await tx.rolePermission.create({ data: { organizationId: f.a.id, roleId: f.roles.CUSTOM.id, permissionCode: PERMISSIONS.FARMS_READ } });
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles.CUSTOM.id } });
  await denied(() => service.requirePermission(f.context, PERMISSIONS.FARMS_READ));
  assert.equal((await request()).status, 200);
  await tx.role.update({ where: { id: f.roles.CUSTOM.id }, data: { status: 'INACTIVE' } });
  assert.equal((await request()).status, 403);
}));
test('authorization: OWNER territory is organization-wide, never a capability bypass', () => scenario(async (tx, f, service, request) => {
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles.OWNER.id } });
  await tx.farmMembership.delete({ where: { id: f.grant.id } });
  const context = { ...f.context, roleId: f.roles.OWNER.id };
  await service.requireFarmAccess(context, f.farm.id);
  assert.equal((await request(`/probe/farm/${f.farm.id}`)).status, 200);
  await denied(() => service.requireFarmAccess(context, f.foreignFarm.id));
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.OWNER.id, permissionCode: PERMISSIONS.INVENTORY_CONSUME_VIA_ACTIVITY } } });
  assert.equal((await request(`/probe/farm/${f.farm.id}`)).status, 403);
}));
for (const role of ['MANAGER', 'AGRONOMIST', 'WORKER']) test(`authorization: ${role} needs capability AND active farm grant`, () => scenario(async (tx, f, _service, request) => {
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles[role].id } });
  const path = `/probe/farm/${f.farm.id}`;
  assert.equal((await request(path)).status, 200);
  await tx.farmMembership.update({ where: { id: f.grant.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  assert.equal((await request(path)).status, 403);
  await tx.farmMembership.delete({ where: { id: f.grant.id } });
  assert.equal((await request(path)).status, 403);
}));
test('authorization: farm grant without capability is insufficient', () => scenario(async (tx, f, _service, request) => {
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.MANAGER.id, permissionCode: PERMISSIONS.INVENTORY_CONSUME_VIA_ACTIVITY } } });
  assert.equal((await request(`/probe/farm/${f.farm.id}`)).status, 403);
}));
test('authorization: foreign, missing and malformed farm IDs are indistinguishable', () => scenario(async (_tx, f, _service, request) => {
  const results = [];
  for (const id of [f.foreignFarm.id, randomUUID(), 'invalid']) results.push(await request(`/probe/farm/${id}`));
  for (const result of results) { assert.equal(result.status, 403); assert.deepEqual(result.body, results[0].body); }
}));
test('authorization: role name OWNER and forged systemCode do not grant territory', () => scenario(async (tx, f, service) => {
  await tx.role.update({ where: { id: f.roles.OWNER.id }, data: { name: 'Protected owner' } });
  await tx.role.update({ where: { id: f.roles.CUSTOM.id }, data: { name: 'OWNER' } });
  await tx.organizationMembership.update({ where: { id: f.member.id }, data: { roleId: f.roles.CUSTOM.id } });
  await tx.farmMembership.delete({ where: { id: f.grant.id } });
  await denied(() => service.requireFarmAccess({ ...f.context, roleId: f.roles.CUSTOM.id, systemRoleCode: 'OWNER' }, f.farm.id));
}));
test('authorization: inactive Farm preserves territorial access for historical operations', () => scenario(async (tx, f, service) => {
  await tx.farm.update({ where: { id: f.farm.id }, data: { status: 'INACTIVE' } });
  await service.requireFarmPermission(f.context, f.farm.id, PERMISSIONS.FARMS_READ);
}));
test('authorization: other user membership, missing context and inactive organization reject', () => scenario(async (tx, f, _service, request) => {
  assert.equal((await request('/probe/read', { membership: f.foreignMember.id })).status, 403);
  assert.equal((await request('/probe/read', { membership: '' })).status, 403);
  await tx.organization.update({ where: { id: f.a.id }, data: { status: 'SUSPENDED' } });
  assert.equal((await request()).status, 403);
}));
test('authorization: suspended and revoked membership reject the same JWT', () => scenario(async (tx, f, service, request) => {
  for (const status of ['SUSPENDED', 'REVOKED']) {
    await tx.organizationMembership.update({ where: { id: f.member.id }, data: { status, revokedAt: status === 'REVOKED' ? new Date() : null } });
    assert.equal((await request()).status, 403);
    await denied(() => service.requireFarmAccess(f.context, f.farm.id));
  }
}));
test('authorization: class and method requirements are cumulative AND, including repeated decorators', () => scenario(async (tx, f, _service, request) => {
  assert.equal((await request('/combined/combined')).status, 200);
  assert.equal((await request('/combined/repeated')).status, 403);
  assert.equal((await request('/combined/emptyRepeated')).status, 403);
  await tx.rolePermission.delete({ where: { roleId_permissionCode: { roleId: f.roles.MANAGER.id, permissionCode: PERMISSIONS.FARMS_READ } } });
  assert.equal((await request('/combined/combined')).status, 403);
}));
test('authorization: 401 without authentication; 403 without capability; Public cannot bypass guard', () => scenario(async (_tx, _f, _service, request) => {
  assert.equal((await request('/probe/read', { token: '' })).status, 401);
  assert.equal((await request('/probe/unknown')).status, 403);
  assert.equal((await request('/probe/publicPermission')).status, 401);
}));
test('authorization: services reject stale, partial and forged context instead of omitting Prisma filters', () => scenario(async (_tx, f, service) => {
  for (const key of ['membershipId', 'organizationId', 'roleId']) {
    for (const value of [undefined, null, '', 'bad', randomUUID()]) await denied(() => service.requireFarmAccess({ ...f.context, [key]: value }, f.farm.id));
  }
  for (const key of ['userId', 'sessionId']) {
    for (const value of [undefined, null, '', 'bad', randomUUID()]) await unauthenticated(() => service.requireFarmAccess({ ...f.context, [key]: value }, f.farm.id));
  }
  await unauthenticated(() => service.requireFarmAccess(undefined, f.farm.id));
}));
test('authorization: service rechecks User, session revocation and expiry', () => scenario(async (tx, f, service, request) => {
  await tx.user.update({ where: { id: f.user.id }, data: { status: 'BLOCKED' } });
  await unauthenticated(() => service.requireFarmAccess(f.context, f.farm.id));
  await tx.user.update({ where: { id: f.user.id }, data: { status: 'ACTIVE' } });
  await tx.authSession.update({ where: { id: f.session.id }, data: { revokedAt: new Date() } });
  await unauthenticated(() => service.requirePermission(f.context, PERMISSIONS.FARMS_READ));
  assert.equal((await request()).status, 401);
  await tx.authSession.update({ where: { id: f.session.id }, data: { revokedAt: null, createdAt: new Date(Date.now() - 20000), expiresAt: new Date(Date.now() - 10000) } });
  await unauthenticated(() => service.requireFarmAccess(f.context, f.farm.id));
}));
