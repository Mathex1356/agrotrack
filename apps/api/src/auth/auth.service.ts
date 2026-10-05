import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { AuthConfig } from './auth.config.js';
import { PasswordService } from './password.service.js';
import type { AuthenticatedUser, OrganizationContext } from './auth.types.js';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = () => new UnauthorizedException('Credenciais ou sessao invalidas.');
type Tokens = { accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresAt: Date };

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly config: AuthConfig,
    private readonly passwords: PasswordService) {}

  async login(normalizedEmail: string, password: string): Promise<Tokens> {
    const user = await this.prisma.user.findUnique({ where: { normalizedEmail }, include: { passwordCredential: true } });
    const valid = await this.passwords.verify(password, user?.passwordCredential?.passwordHash);
    if (!valid || !user || user.status !== 'ACTIVE') throw invalid();
    return this.prisma.$transaction(async tx => {
      // Recheck after the deliberately expensive password verification.
      const current = await tx.user.findUnique({ where: { id: user.id }, include: { passwordCredential: true } });
      if (!current || current.status !== 'ACTIVE'
        || current.passwordCredential?.passwordHash !== user.passwordCredential?.passwordHash) throw invalid();
      const now = new Date();
      const session = await tx.authSession.create({ data: {
        userId: user.id, expiresAt: new Date(now.getTime() + this.config.sessionSeconds * 1000),
      } });
      return this.issue(tx, session.id, user.id, session.expiresAt);
    });
  }

  private async issue(tx: Prisma.TransactionClient, sessionId: string, userId: string, sessionExpiry: Date): Promise<Tokens> {
    const now = Date.now();
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(Math.min(sessionExpiry.getTime(), now + this.config.refreshSeconds * 1000));
    await tx.refreshToken.create({ data: { sessionId, tokenDigest: digest(refreshToken), expiresAt: refreshExpiresAt } });
    const expiresAt = Math.min(Math.floor(sessionExpiry.getTime() / 1000), Math.floor(now / 1000) + this.config.accessSeconds);
    const accessToken = await new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setSubject(userId).setIssuer(this.config.issuer).setAudience(this.config.audience)
      .setIssuedAt().setExpirationTime(expiresAt).sign(this.config.jwtKey);
    return { accessToken, refreshToken, expiresIn: Math.max(0, expiresAt - Math.floor(now / 1000)), refreshExpiresAt };
  }

  async refresh(token: string): Promise<Tokens> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
    const result = await this.prisma.$transaction(async tx => {
      const initial = await tx.refreshToken.findUnique({ where: { tokenDigest: digest(token) }, select: { sessionId: true } });
      if (!initial) return null;
      await tx.$queryRaw`SELECT "id" FROM "AuthSession" WHERE "id" = ${initial.sessionId}::uuid FOR UPDATE`;
      const session = await tx.authSession.findUnique({ where: { id: initial.sessionId }, include: { user: true } });
      const stored = await tx.refreshToken.findUnique({ where: { tokenDigest: digest(token) } });
      if (!session || !stored || session.revokedAt) return null;
      const now = new Date();
      if (stored.consumedAt || session.expiresAt <= now || stored.expiresAt <= now || session.user.status !== 'ACTIVE') {
        await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: now } });
        return null; // Commit revocation BEFORE returning the authentication error.
      }
      await tx.refreshToken.update({ where: { id: stored.id }, data: { consumedAt: now } });
      return this.issue(tx, session.id, session.userId, session.expiresAt);
    });
    if (!result) throw invalid();
    return result;
  }

  async logout(token: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    await this.prisma.$transaction(async tx => {
      const stored = await tx.refreshToken.findUnique({ where: { tokenDigest: digest(token) }, select: { sessionId: true } });
      if (!stored) return;
      await tx.$queryRaw`SELECT "id" FROM "AuthSession" WHERE "id" = ${stored.sessionId}::uuid FOR UPDATE`;
      await tx.authSession.updateMany({ where: { id: stored.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
  }

  async authenticate(token: string): Promise<AuthenticatedUser> {
    let subject: string;
    let sessionId: string;
    try {
      const { payload } = await jwtVerify(token, this.config.jwtKey, {
        algorithms: ['HS256'], issuer: this.config.issuer, audience: this.config.audience,
        typ: 'at+jwt', requiredClaims: ['sub', 'sid', 'iat', 'exp'], maxTokenAge: this.config.accessSeconds,
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string'
        || !UUID_PATTERN.test(payload.sub) || !UUID_PATTERN.test(payload.sid)) throw invalid();
      subject = payload.sub; sessionId = payload.sid;
    } catch { throw invalid(); }
    const session = await this.prisma.authSession.findFirst({ where: {
      id: sessionId, userId: subject, revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' },
    }, select: { id: true, userId: true } });
    if (!session) throw invalid();
    return Object.freeze({ userId: session.userId, sessionId: session.id });
  }

  async context(user: AuthenticatedUser, membershipId: string): Promise<OrganizationContext> {
    if (!UUID_PATTERN.test(membershipId)) throw new ForbiddenException('Contexto indisponivel.');
    const membership = await this.prisma.organizationMembership.findFirst({ where: {
      id: membershipId, userId: user.userId, status: 'ACTIVE', organization: { status: 'ACTIVE' }, role: { status: 'ACTIVE' },
    }, select: { id: true, organizationId: true, roleId: true, role: { select: { organizationId: true } } } });
    if (!membership || membership.role.organizationId !== membership.organizationId) throw new ForbiddenException('Contexto indisponivel.');
    return Object.freeze({ ...user, organizationId: membership.organizationId, membershipId: membership.id, roleId: membership.roleId });
  }

  async me(user: AuthenticatedUser) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: { id: true, displayName: true, email: true } });
  }

  async memberships(user: AuthenticatedUser) {
    return this.prisma.organizationMembership.findMany({ where: {
      userId: user.userId, status: 'ACTIVE', organization: { status: 'ACTIVE' }, role: { status: 'ACTIVE' },
    }, select: { id: true, organizationId: true, roleId: true,
      organization: { select: { name: true } }, role: { select: { name: true, systemCode: true } } }, orderBy: { id: 'asc' } });
  }
}
