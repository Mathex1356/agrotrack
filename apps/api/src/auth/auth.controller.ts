import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { AuthConfig } from './auth.config.js';
import { RateLimitService } from './rate-limit.service.js';
import { CurrentContext, CurrentUser, Public, RequireOrganization } from './auth.decorators.js';
import type { AuthenticatedUser, OrganizationContext } from './auth.types.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: AuthConfig, private readonly limits: RateLimitService) {}

  private browserRequest(request: Request): void {
    const origin = request.headers.origin;
    if (!origin || !this.config.origins.includes(origin) || request.headers['x-agrotrack-csrf'] !== '1'
      || !request.is('application/json')) throw new ForbiddenException('Origem ou formato da requisicao nao permitido.');
  }
  private cookie(request: Request): string {
    const values = (request.headers.cookie ?? '').split(';').map(item => item.trim())
      .filter(item => item.startsWith(`${this.config.cookieName}=`));
    return values.length === 1 ? values[0].slice(this.config.cookieName.length + 1) : '';
  }
  private cookieOptions() {
    return { httpOnly: true, secure: this.config.production, sameSite: 'strict' as const, path: '/auth' };
  }
  private tokenResponse(response: Response, tokens: Awaited<ReturnType<AuthService['refresh']>>) {
    response.cookie(this.config.cookieName, tokens.refreshToken, { ...this.cookieOptions(), expires: tokens.refreshExpiresAt });
    return { accessToken: tokens.accessToken, tokenType: 'Bearer', expiresIn: tokens.expiresIn };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() body: unknown) {
    this.browserRequest(request);
    await this.limits.consume('login-ip', request.ip ?? request.socket.remoteAddress ?? 'unknown', this.config.loginIpLimit);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Entrada invalida.');
    const data = body as Record<string, unknown>;
    if (Object.keys(data).some(key => !['email', 'password'].includes(key))
      || typeof data.email !== 'string' || typeof data.password !== 'string'
      || data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())
      || Buffer.byteLength(data.password, 'utf8') < 1 || Buffer.byteLength(data.password, 'utf8') > 1024) {
      throw new BadRequestException('Entrada invalida.');
    }
    const email = data.email.trim().toLowerCase();
    await this.limits.consume('login-email', email, this.config.loginEmailLimit);
    return this.tokenResponse(response, await this.auth.login(email, data.password));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    this.browserRequest(request);
    await this.limits.consume('refresh-ip', request.ip ?? request.socket.remoteAddress ?? 'unknown', this.config.refreshIpLimit);
    try { return this.tokenResponse(response, await this.auth.refresh(this.cookie(request))); }
    catch (error) { response.clearCookie(this.config.cookieName, this.cookieOptions()); throw error; }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    this.browserRequest(request);
    await this.limits.consume('logout-ip', request.ip ?? request.socket.remoteAddress ?? 'unknown', this.config.refreshIpLimit);
    await this.auth.logout(this.cookie(request));
    response.clearCookie(this.config.cookieName, this.cookieOptions());
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) { return this.auth.me(user); }

  @Get('memberships')
  memberships(@CurrentUser() user: AuthenticatedUser) { return this.auth.memberships(user); }

  @Get('context')
  @RequireOrganization()
  context(@CurrentContext() context: OrganizationContext) { return context; }
}
