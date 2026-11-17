import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentContext } from '../auth/auth.decorators.js';
import type { OrganizationContext } from '../auth/auth.types.js';
import { RequirePermission } from '../authorization/authorization.decorators.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { noResourceQuery, resourceId } from '../catalog-input.js';
import { PlantingsService } from './plantings.service.js';
import { createPlantingInput, patchPlantingInput, plantingPage } from './plantings.validation.js';
@Controller('farms/:farmId/plantings')
export class PlantingsController {
  constructor(private readonly plantings: PlantingsService) {}
  @Post()
  @RequirePermission(PERMISSIONS.PLANTINGS_MANAGE)
  create(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Body() body: unknown, @Query() query: unknown) {
    noResourceQuery(query); return this.plantings.create(context, resourceId(farmId), createPlantingInput(body));
  }
  @Get()
  @RequirePermission(PERMISSIONS.FARMS_READ)
  list(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Query() query: unknown) {
    return this.plantings.list(context, resourceId(farmId), plantingPage(query));
  }
  @Get(':id')
  @RequirePermission(PERMISSIONS.FARMS_READ)
  detail(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Param('id') id: string, @Query() query: unknown) {
    noResourceQuery(query); return this.plantings.detail(context, resourceId(farmId), resourceId(id));
  }
  @Patch(':id')
  @RequirePermission(PERMISSIONS.PLANTINGS_MANAGE)
  update(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Param('id') id: string, @Body() body: unknown, @Query() query: unknown) {
    noResourceQuery(query); return this.plantings.update(context, resourceId(farmId), resourceId(id), patchPlantingInput(body));
  }
}


