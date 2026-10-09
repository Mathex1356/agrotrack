import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentContext } from '../auth/auth.decorators.js';
import type { OrganizationContext } from '../auth/auth.types.js';
import { RequirePermission } from '../authorization/authorization.decorators.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { FieldsService } from './fields.service.js';
import { createFieldInput, fieldPage, fieldRouteId, noFieldQuery, patchFieldInput } from './fields.validation.js';

@Controller('farms/:farmId/fields')
export class FieldsController {
  constructor(private readonly fields: FieldsService) {}
  @Post()
  @RequirePermission(PERMISSIONS.FIELDS_MANAGE)
  create(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Body() body: unknown, @Query() query: unknown) {
    noFieldQuery(query);
    return this.fields.create(context, fieldRouteId(farmId), createFieldInput(body));
  }
  @Get()
  @RequirePermission(PERMISSIONS.FARMS_READ)
  list(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Query() query: unknown) {
    return this.fields.list(context, fieldRouteId(farmId), fieldPage(query));
  }
  @Get(':id')
  @RequirePermission(PERMISSIONS.FARMS_READ)
  detail(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Param('id') id: string, @Query() query: unknown) {
    noFieldQuery(query);
    return this.fields.detail(context, fieldRouteId(farmId), fieldRouteId(id));
  }
  @Patch(':id')
  @RequirePermission(PERMISSIONS.FIELDS_MANAGE)
  update(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Param('id') id: string, @Body() body: unknown, @Query() query: unknown) {
    noFieldQuery(query);
    return this.fields.update(context, fieldRouteId(farmId), fieldRouteId(id), patchFieldInput(body));
  }
}
