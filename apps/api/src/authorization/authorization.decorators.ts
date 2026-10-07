import { applyDecorators, UseGuards } from '@nestjs/common';
import { RequireOrganization } from '../auth/auth.decorators.js';
import { PermissionGuard } from './permission.guard.js';
import type { PermissionCode } from './permissions.js';

export const REQUIRED_PERMISSIONS = 'agrotrack.permissions';

export function RequirePermission(...codes: PermissionCode[]): ClassDecorator & MethodDecorator {
  return applyDecorators(
    RequireOrganization(),
    (target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
      const subject: object = descriptor?.value ?? target;
      const previous: unknown = Reflect.getOwnMetadata(REQUIRED_PERMISSIONS, subject);
      // Preserve an empty/invalid declaration as a denial, even with another decorator.
      const groups = previous === undefined ? [] : Array.isArray(previous) ? previous : [previous];
      Reflect.defineMetadata(REQUIRED_PERMISSIONS, [...groups, Object.freeze([...codes])], subject);
    },
    UseGuards(PermissionGuard),
  );
}
