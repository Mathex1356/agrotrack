import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { permissions, seedPermissions, provisionSystemRoles } from '../prisma/permissions.mjs';

let prisma;
const rollback = new Error('Rollback test fixture');
before(async () => {
  loadEnvironment();
  prisma = new PrismaService();
  await prisma.onModuleInit();
});
after(async () => { await prisma?.$disconnect(); });

// Never emit Prisma errors: they can include SQL arguments and invitation digests.
function errorCode(error) {
  return error?.meta?.driverAdapterError?.cause?.originalCode
    ?? error?.meta?.code ?? error?.code ?? 'UNKNOWN';
}

async function transaction(run, expected) {
  let reachedOperation = false;
  try {
    await prisma.$transaction(async (tx) => {
      const f = await fixture(tx);
      reachedOperation = true;
      await run(tx, f);
      throw rollback;
    }, { timeout: 15000 });
  } catch (error) {
    if (error === rollback) {
      assert.equal(expected, undefined, 'Expected PostgreSQL to reject the operation');
      return;
    }
    if (error?.name === 'AssertionError') throw error;
    assert.ok(reachedOperation, `Fixture failed (code ${errorCode(error)})`);
    assert.ok(expected, `Unexpected database failure (code ${errorCode(error)})`);
    assert.ok(expected.includes(errorCode(error)), `Expected ${expected}, received ${errorCode(error)}`);
  }
}

async function fixture(tx) {
  const tag = randomUUID().toUpperCase();
  const a = await tx.organization.create({ data: { name: 'Test A', referenceCode: `TEST-A-${tag}` } });
  const b = await tx.organization.create({ data: { name: 'Test B', referenceCode: `TEST-B-${tag}` } });
  const email = `${tag.toLowerCase()}@example.invalid`;
  const user = await tx.user.create({ data: { displayName: 'Test', email, normalizedEmail: email } });
  const ra = await tx.role.create({ data: { organizationId: a.id, name: 'Owner', systemCode: 'OWNER' } });
  const rb = await tx.role.create({ data: { organizationId: b.id, name: 'Owner', systemCode: 'OWNER' } });
  const ma = await tx.organizationMembership.create({ data: { organizationId: a.id, userId: user.id, roleId: ra.id } });
  const mb = await tx.organizationMembership.create({ data: { organizationId: b.id, userId: user.id, roleId: rb.id } });
  const farmData = { code: 'F1', name: 'Test Farm', municipality: 'Test', state: 'SP', country: 'BR', timezone: 'America/Sao_Paulo', totalAreaHa: '100', productiveAreaHa: '90' };
  const fa = await tx.farm.create({ data: { ...farmData, organizationId: a.id } });
  const fb = await tx.farm.create({ data: { ...farmData, organizationId: b.id } });
  const fm = await tx.farmMembership.create({ data: { organizationId: a.id, organizationMembershipId: ma.id, farmId: fa.id } });
  // Synthetic non-secret digest fixture, not a token generator.
  const invitationData = { organizationId: a.id, normalizedEmail: email, roleId: ra.id, inviterMembershipId: ma.id, tokenDigest: `test-digest-${tag}`, expiresAt: new Date(Date.now() + 86400000) };
  const invitation = await tx.invitation.create({ data: invitationData });
  await tx.invitationFarm.create({ data: { organizationId: a.id, invitationId: invitation.id, farmId: fa.id } });
  return { a, b, user, ra, rb, ma, mb, fa, fb, fm, invitation, invitationData, farmData };
}

const unique = ['P2002', '23505'];
const fk = ['P2003', '23503'];
const check = ['23514'];
const negative = (name, expected, run) => test(name, () => transaction(run, expected));

test('valid ten-model graph, global user and repeatable permission/role provisioning', () => transaction(async (tx, f) => {
  await seedPermissions(tx);
  await seedPermissions(tx);
  await provisionSystemRoles(tx, f.a.id);
  await provisionSystemRoles(tx, f.a.id);
  assert.equal(await tx.role.count({ where: { organizationId: f.a.id } }), 4);
  assert.equal(await tx.rolePermission.count({ where: { roleId: f.ra.id } }), permissions.length);
  const worker = await tx.role.findUniqueOrThrow({ where: { organizationId_systemCode: { organizationId: f.a.id, systemCode: 'WORKER' } }, include: { permissions: true } });
  assert.deepEqual(worker.permissions.map((p) => p.permissionCode).sort(), [
    'activities.execute_assigned', 'farms.read_assigned_work', 'harvest.record_assigned', 'inventory.consume_via_activity',
  ]);
  assert.equal(await tx.organizationMembership.count({ where: { userId: f.user.id } }), 2);
  assert.equal(f.fa.totalAreaHa.toString(), '100');
  const accepted = await tx.invitation.update({ where: { id: f.invitation.id }, data: { acceptedAt: new Date(), acceptedMembershipId: f.ma.id } });
  assert.equal(accepted.acceptedMembershipId, f.ma.id);
  await tx.role.createMany({ data: [{ organizationId: f.a.id, name: 'Future A' }, { organizationId: f.a.id, name: 'Future B' }] });
}));

negative('global normalizedEmail uniqueness', unique, (tx, f) => tx.user.create({ data: { displayName: 'Duplicate', email: f.user.email, normalizedEmail: f.user.normalizedEmail } }));
negative('email must match canonical lower/trim form', check, (tx, f) => tx.user.update({ where: { id: f.user.id }, data: { normalizedEmail: 'WRONG' } }));
negative('membership cannot use another tenant role', fk, (tx, f) => tx.organizationMembership.update({ where: { id: f.ma.id }, data: { roleId: f.rb.id } }));
negative('membership organization/user pair is durable', unique, (tx, f) => tx.organizationMembership.create({ data: { organizationId: f.a.id, userId: f.user.id, roleId: f.ra.id } }));
negative('FarmMembership cannot reference another tenant farm', fk, (tx, f) => tx.farmMembership.create({ data: { organizationId: f.a.id, organizationMembershipId: f.ma.id, farmId: f.fb.id } }));
negative('FarmMembership cannot reference another tenant member', fk, (tx, f) => tx.farmMembership.create({ data: { organizationId: f.a.id, organizationMembershipId: f.mb.id, farmId: f.fa.id } }));
negative('FarmMembership pair unique', unique, (tx, f) => tx.farmMembership.create({ data: { organizationId: f.a.id, organizationMembershipId: f.ma.id, farmId: f.fa.id } }));
negative('Invitation role must belong to tenant', fk, (tx, f) => tx.invitation.update({ where: { id: f.invitation.id }, data: { roleId: f.rb.id } }));
negative('Invitation inviter must belong to tenant', fk, (tx, f) => tx.invitation.update({ where: { id: f.invitation.id }, data: { inviterMembershipId: f.mb.id } }));
negative('Invitation accepted membership must belong to tenant', fk, (tx, f) => tx.invitation.update({ where: { id: f.invitation.id }, data: { acceptedAt: new Date(), acceptedMembershipId: f.mb.id } }));
negative('InvitationFarm cannot reference another tenant farm', fk, (tx, f) => tx.invitationFarm.create({ data: { organizationId: f.a.id, invitationId: f.invitation.id, farmId: f.fb.id } }));
negative('InvitationFarm cannot reference another tenant invitation', fk, (tx, f) => tx.invitationFarm.create({ data: { organizationId: f.b.id, invitationId: f.invitation.id, farmId: f.fb.id } }));
negative('InvitationFarm pair unique', unique, (tx, f) => tx.invitationFarm.create({ data: { organizationId: f.a.id, invitationId: f.invitation.id, farmId: f.fa.id } }));
negative('tokenDigest globally unique', unique, (tx, f) => tx.invitation.create({ data: f.invitationData }));
negative('invitation acceptance requires membership and timestamp together', check, (tx, f) => tx.invitation.update({ where: { id: f.invitation.id }, data: { acceptedAt: new Date() } }));
negative('invitation cannot be both accepted and revoked', check, (tx, f) => tx.invitation.update({ where: { id: f.invitation.id }, data: { acceptedAt: new Date(), acceptedMembershipId: f.ma.id, revokedAt: new Date() } }));
negative('invitation expiry after creation', check, (tx, f) => tx.invitation.update({ where: { id: f.invitation.id }, data: { expiresAt: new Date(0) } }));
negative('productive area cannot exceed total', check, (tx, f) => tx.farm.update({ where: { id: f.fa.id }, data: { productiveAreaHa: '101' } }));
negative('total area must be positive', check, (tx, f) => tx.farm.update({ where: { id: f.fa.id }, data: { totalAreaHa: '0', productiveAreaHa: '0' } }));
negative('negative total area rejected', check, (tx, f) => tx.farm.update({ where: { id: f.fa.id }, data: { totalAreaHa: '-1', productiveAreaHa: '0' } }));
negative('negative productive area rejected', check, (tx, f) => tx.farm.update({ where: { id: f.fa.id }, data: { productiveAreaHa: '-1' } }));
negative('NaN area rejected by PostgreSQL', check, (tx, f) => tx.$executeRaw`UPDATE "Farm" SET "totalAreaHa" = 'NaN'::numeric WHERE id = ${f.fa.id}::uuid`);
negative('farm code unique within tenant', unique, (tx, f) => tx.farm.create({ data: { ...f.farmData, organizationId: f.a.id } }));
negative('system role code unique within tenant', unique, (tx, f) => tx.role.create({ data: { organizationId: f.a.id, name: 'Duplicate owner', systemCode: 'OWNER' } }));
negative('system role identity protected', check, (tx, f) => tx.role.update({ where: { id: f.ra.id }, data: { systemCode: 'MANAGER' } }));
negative('system roles cannot be inactivated', check, (tx, f) => tx.role.update({ where: { id: f.ra.id }, data: { status: 'INACTIVE' } }));
negative('system role deletion protected even without dependents', check, async (tx, f) => {
  const role = await tx.role.create({ data: { organizationId: f.a.id, name: 'Worker', systemCode: 'WORKER' } });
  await tx.role.delete({ where: { id: role.id } });
});
negative('revocation timestamp required', check, (tx, f) => tx.organizationMembership.update({ where: { id: f.ma.id }, data: { status: 'REVOKED' } }));
negative('farm revocation timestamp required', check, (tx, f) => tx.farmMembership.update({ where: { id: f.fm.id }, data: { status: 'REVOKED' } }));
negative('referenced farm cannot cascade-delete history', ['23001', 'P2003'], (tx, f) => tx.farm.delete({ where: { id: f.fa.id } }));
negative('RolePermission rejects role from another tenant', fk, async (tx, f) => {
  await seedPermissions(tx);
  await tx.rolePermission.create({ data: { organizationId: f.a.id, roleId: f.rb.id, permissionCode: 'farms.read' } });
});
negative('RolePermission pair unique', unique, async (tx, f) => {
  await seedPermissions(tx);
  const data = { organizationId: f.a.id, roleId: f.ra.id, permissionCode: 'farms.read' };
  await tx.rolePermission.create({ data });
  await tx.rolePermission.create({ data });
});
