// Stable application capabilities. Keep parity with prisma/permissions.mjs.
export const PERMISSIONS = {
  ORGANIZATION_MANAGE: 'organization.manage',
  MEMBERS_MANAGE: 'members.manage',
  ROLES_MANAGE: 'roles.manage',
  FARMS_MANAGE: 'farms.manage',
  FARMS_READ: 'farms.read',
  FARMS_READ_ASSIGNED_WORK: 'farms.read_assigned_work',
  FIELDS_MANAGE: 'fields.manage',
  SEASONS_MANAGE: 'seasons.manage',
  PLANTINGS_MANAGE: 'plantings.manage',
  ACTIVITIES_PLAN: 'activities.plan',
  ACTIVITIES_PLAN_TECHNICAL: 'activities.plan_technical',
  ACTIVITIES_EXECUTE: 'activities.execute',
  ACTIVITIES_EXECUTE_TECHNICAL: 'activities.execute_technical',
  ACTIVITIES_EXECUTE_ASSIGNED: 'activities.execute_assigned',
  INVENTORY_RECEIVE: 'inventory.receive',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_TRANSFER: 'inventory.transfer',
  INVENTORY_CONSUME_VIA_ACTIVITY: 'inventory.consume_via_activity',
  HARVEST_RECORD: 'harvest.record',
  HARVEST_RECORD_ASSIGNED: 'harvest.record_assigned',
  OPERATIONS_REVERSE: 'operations.reverse',
  COSTS_READ: 'costs.read',
  AUDIT_READ: 'audit.read',
  AUDIT_READ_FARM: 'audit.read_farm',
  AUDIT_READ_TECHNICAL: 'audit.read_technical',
} as const;

export type PermissionCode = typeof PERMISSIONS[keyof typeof PERMISSIONS];
const knownCodes: ReadonlySet<string> = new Set(Object.values(PERMISSIONS));
export const isPermissionCode = (value: unknown): value is PermissionCode =>
  typeof value === 'string' && knownCodes.has(value);
