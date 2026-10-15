import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentContext } from '../auth/auth.decorators.js';
import type { OrganizationContext } from '../auth/auth.types.js';
import { RequirePermission } from '../authorization/authorization.decorators.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { noResourceQuery, resourceId, resourcePage } from '../catalog-input.js';
import { SeasonsService } from './seasons.service.js';
import { createSeasonInput, patchSeasonInput } from './seasons.validation.js';
@Controller('farms/:farmId/seasons')
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}
  @Post()
  @RequirePermission(PERMISSIONS.SEASONS_MANAGE)
  create(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Body() body: unknown, @Query() query: unknown) {
    noResourceQuery(query); return this.seasons.create(context, resourceId(farmId), createSeasonInput(body));
  }
  @Get()
  @RequirePermission(PERMISSIONS.FARMS_READ)
  list(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Query() query: unknown) {
    return this.seasons.list(context, resourceId(farmId), resourcePage(query));
  }
  @Get(':id')
  @RequirePermission(PERMISSIONS.FARMS_READ)
  detail(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Param('id') id: string, @Query() query: unknown) {
    noResourceQuery(query); return this.seasons.detail(context, resourceId(farmId), resourceId(id));
  }
  @Patch(':id')
  @RequirePermission(PERMISSIONS.SEASONS_MANAGE)
  update(@CurrentContext() context: OrganizationContext, @Param('farmId') farmId: string, @Param('id') id: string, @Body() body: unknown, @Query() query: unknown) {
    noResourceQuery(query); return this.seasons.update(context, resourceId(farmId), resourceId(id), patchSeasonInput(body));
  }
}
