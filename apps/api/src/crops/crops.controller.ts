import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentContext } from '../auth/auth.decorators.js';
import type { OrganizationContext } from '../auth/auth.types.js';
import { RequirePermission } from '../authorization/authorization.decorators.js';
import { PERMISSIONS } from '../authorization/permissions.js';
import { noResourceQuery, resourceId, resourcePage } from '../catalog-input.js';
import { CropsService } from './crops.service.js';
import { createCropInput, patchCropInput } from './crops.validation.js';
@Controller('crops')
export class CropsController {
  constructor(private readonly crops: CropsService) {}
  @Post()
  @RequirePermission(PERMISSIONS.CROPS_MANAGE)
  create(@CurrentContext() context: OrganizationContext, @Body() body: unknown, @Query() query: unknown) {
    noResourceQuery(query); return this.crops.create(context, createCropInput(body));
  }
  @Get()
  @RequirePermission(PERMISSIONS.CROPS_READ)
  list(@CurrentContext() context: OrganizationContext, @Query() query: unknown) { return this.crops.list(context, resourcePage(query)); }
  @Get(':id')
  @RequirePermission(PERMISSIONS.CROPS_READ)
  detail(@CurrentContext() context: OrganizationContext, @Param('id') id: string, @Query() query: unknown) {
    noResourceQuery(query); return this.crops.detail(context, resourceId(id));
  }
  @Patch(':id')
  @RequirePermission(PERMISSIONS.CROPS_MANAGE)
  update(@CurrentContext() context: OrganizationContext, @Param('id') id: string, @Body() body: unknown, @Query() query: unknown) {
    noResourceQuery(query); return this.crops.update(context, resourceId(id), patchCropInput(body));
  }
}
