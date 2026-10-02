// Capabilities only: farm access and assignment checks remain mandatory.
const definitions = [
  ['organization.manage', 'ORGANIZATION', 'Administrar a organização', []],
  ['members.manage', 'ORGANIZATION', 'Gerenciar membros, convites e vínculos territoriais', []],
  ['roles.manage', 'ORGANIZATION', 'Administrar papéis conforme políticas protegidas', []],
  ['farms.manage', 'ORGANIZATION', 'Cadastrar e inativar fazendas', []],
  ['farms.read', 'FARM', 'Consultar operação e mapas das fazendas autorizadas', ['MANAGER', 'AGRONOMIST']],
  ['farms.read_assigned_work', 'FARM', 'Consultar informações necessárias ao trabalho atribuído', ['WORKER']],
  ['fields.manage', 'FARM', 'Gerenciar talhões no escopo técnico autorizado', ['MANAGER', 'AGRONOMIST']],
  ['seasons.manage', 'FARM', 'Gerenciar safras no escopo técnico autorizado', ['MANAGER', 'AGRONOMIST']],
  ['plantings.manage', 'FARM', 'Gerenciar plantios no escopo técnico autorizado', ['MANAGER', 'AGRONOMIST']],
  ['activities.plan', 'FARM', 'Planejar e atribuir atividades operacionais', ['MANAGER']],
  ['activities.plan_technical', 'FARM', 'Planejar e atribuir atividades técnicas', ['AGRONOMIST']],
  ['activities.execute', 'FARM', 'Executar atividades operacionais', ['MANAGER']],
  ['activities.execute_technical', 'FARM', 'Executar atividades técnicas autorizadas', ['AGRONOMIST']],
  ['activities.execute_assigned', 'FARM', 'Executar somente atividades atribuídas e autorizadas', ['WORKER']],
  ['inventory.receive', 'FARM', 'Registrar compras e entradas de insumos', ['MANAGER']],
  ['inventory.adjust', 'FARM', 'Ajustar estoque com motivo e auditoria', ['MANAGER']],
  ['inventory.transfer', 'FARM', 'Transferir estoque entre duas fazendas autorizadas', ['MANAGER']],
  ['inventory.consume_via_activity', 'FARM', 'Registrar consumo através de execução autorizada', ['MANAGER', 'AGRONOMIST', 'WORKER']],
  ['harvest.record', 'FARM', 'Registrar produção nas fazendas autorizadas', ['MANAGER', 'AGRONOMIST']],
  ['harvest.record_assigned', 'FARM', 'Registrar produção somente em atividade de colheita atribuída', ['WORKER']],
  ['operations.reverse', 'FARM', 'Estornar fatos através de correções auditadas', ['MANAGER']],
  ['costs.read', 'FARM', 'Consultar custos operacionais autorizados', ['MANAGER']],
  ['audit.read', 'ORGANIZATION', 'Consultar auditoria organizacional', []],
  ['audit.read_farm', 'FARM', 'Consultar auditoria das fazendas autorizadas', ['MANAGER']],
  ['audit.read_technical', 'FARM', 'Consultar evidências técnicas autorizadas', ['AGRONOMIST']],
];

export const permissions = definitions.map(([code, scope, description]) => ({
  code, scope, description, status: 'ACTIVE',
}));

export const systemRolePermissions = Object.fromEntries(
  ['OWNER', 'MANAGER', 'AGRONOMIST', 'WORKER'].map((role) => [
    role,
    definitions.filter(([, , , roles]) => role === 'OWNER' || roles.includes(role)).map(([code]) => code),
  ]),
);

export async function seedPermissions(tx) {
  for (const permission of permissions) {
    await tx.permission.upsert({
      where: { code: permission.code }, create: permission, update: permission,
    });
  }
}

// Future trusted provisioning must call this within its own transaction.
// Does not create an organization, owner, user or territorial grant.
export async function provisionSystemRoles(tx, organizationId) {
  await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  for (const [systemCode, codes] of Object.entries(systemRolePermissions)) {
    const role = await tx.role.upsert({
      where: { organizationId_systemCode: { organizationId, systemCode } },
      create: { organizationId, systemCode, name: systemCode }, update: {},
    });
    await tx.rolePermission.createMany({
      data: codes.map((permissionCode) => ({ organizationId, roleId: role.id, permissionCode })),
      skipDuplicates: true,
    });
  }
}
