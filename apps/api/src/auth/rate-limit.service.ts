import { HttpException, Injectable } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthConfig } from './auth.config.js';

@Injectable()
export class RateLimitService {
  private cleanupAfter = 0;
  constructor(private readonly prisma: PrismaService, private readonly config: AuthConfig) {}

  async consume(scope: string, identity: string, limit: number): Promise<void> {
    if (Date.now() >= this.cleanupAfter) {
      this.cleanupAfter = Date.now() + 60000;
      // Bounded maintenance; only expired disposable counters, never session history.
      await this.prisma.$executeRaw`DELETE FROM "AuthRateLimit" WHERE "key" IN
        (SELECT "key" FROM "AuthRateLimit" WHERE "expiresAt" < clock_timestamp()
          ORDER BY "expiresAt" LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
    }
    const key = createHmac('sha256', this.config.rateKey).update(`${scope}\0${identity}`).digest('hex');
    // Atomic fixed windows shared across instances. Do not reset after successful login.
    const rows = await this.prisma.$queryRaw<{ attempts: number }[]>`
      INSERT INTO "AuthRateLimit" ("key", "windowStartedAt", "expiresAt", "attempts")
      VALUES (${key}, clock_timestamp(), clock_timestamp() + ${this.config.rateWindowSeconds} * interval '1 second', 1)
      ON CONFLICT ("key") DO UPDATE SET
        "attempts" = CASE WHEN "AuthRateLimit"."expiresAt" <= clock_timestamp() THEN 1
          ELSE LEAST("AuthRateLimit"."attempts" + 1, ${limit + 1}) END,
        "windowStartedAt" = CASE WHEN "AuthRateLimit"."expiresAt" <= clock_timestamp()
          THEN clock_timestamp() ELSE "AuthRateLimit"."windowStartedAt" END,
        "expiresAt" = CASE WHEN "AuthRateLimit"."expiresAt" <= clock_timestamp()
          THEN clock_timestamp() + ${this.config.rateWindowSeconds} * interval '1 second'
          ELSE "AuthRateLimit"."expiresAt" END
      RETURNING "attempts"`;
    if (rows[0].attempts > limit) throw new HttpException('Muitas tentativas. Tente novamente mais tarde.', 429);
  }
}
