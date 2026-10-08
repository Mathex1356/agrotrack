import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentContext } from '../auth/auth.decorators.js';
import type { OrganizationContext } from '../auth/auth.types.js';
import { RequirePermission } from '../authorization/authorization.decorators.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { FarmsService } from './farms.service.js';
import { createFarmInput, farmId, farmPage, noFarmQuery, patchFarmInput } from './farms.validation.js';

@Controller('farms')
export class FarmsController {
  constructor(private readonly farms: FarmsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.FARMS_MANAGE)
  create(@CurrentContext() context: OrganizationContext, @Body() body: unknown, @Query() query: unknown) {
    noFarmQuery(query);
    return this.farms.create(context, createFarmInput(body));
  }

  @Get()
  @RequirePermission(PERMISSIONS.FARMS_READ)
  list(@CurrentContext() context: OrganizationContext, @Query() query: unknown) {
    return this.farms.list(context, farmPage(query));
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.FARMS_READ)
  detail(@CurrentContext() context: OrganizationContext, @Param('id') id: string, @Query() query: unknown) {
    noFarmQuery(query);
    return this.farms.detail(context, farmId(id));
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.FARMS_MANAGE)
  update(@CurrentContext() context: OrganizationContext, @Param('id') id: string, @Body() body: unknown, @Query() query: unknown) {
    noFarmQuery(query);
    return this.farms.update(context, farmId(id), patchFarmInput(body));
  }
}
