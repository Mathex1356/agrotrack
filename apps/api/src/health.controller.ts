import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service.js';
import { Public } from './auth/auth.decorators.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  async getHealth(): Promise<{ status: string; api: string; database: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', api: 'operational', database: 'connected' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'degraded', api: 'operational', database: 'disconnected',
      });
    }
  }
}
