import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { SignJWT, decodeJwt } from 'jose';
import { AppModule } from '../dist/app.module.js';
import { configureHttp } from '../dist/http-security.js';
import { loadEnvironment } from '../dist/config/environment.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { PasswordService } from '../dist/auth/password.service.js';
import { AuthConfig } from '../dist/auth/auth.config.js';
import { RateLimitService } from '../dist/auth/rate-limit.service.js';

loadEnvironment();
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET = randomBytes(32).toString('base64url');
process.env.AUTH_RATE_LIMIT_SECRET = randomBytes(32).toString('base64url');
process.env.AUTH_ALLOWED_ORIGINS = 'http://localhost:5173';
process.env.AUTH_LOGIN_IP_LIMIT = '1000';
process.env.AUTH_LOGIN_EMAIL_LIMIT = '100';
process.env.AUTH_REFRESH_IP_LIMIT = '1000';
const origin = 'http://localhost:5173';
const password = randomBytes(24).toString('base64url');
const ids = Array.from({ length: 8 }, () => randomUUID());
const [userId, otherId, orgA, orgB, roleA, roleB, memberA, memberB] = ids;
const email = `${userId}@example.test`;
let app, db, base, config;
const digest = value => createHash('sha256').update(value).digest('hex');
const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-AgroTrack-CSRF': '1' };

async function request(path, { method = 'GET', body, token, cookie, membership, extra = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    ...(method === 'POST' ? headers : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}), ...(membership ? { 'X-Organization-Membership-Id': membership } : {}), ...extra,
  }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers,
    cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function login() {
  const result = await request('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.status, 200);
  return { token: result.body.accessToken, cookie: result.cookie };
}

before(async () => {
  try {
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
  configureHttp(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl(); db = app.get(PrismaService); config = app.get(AuthConfig);
  const hash = await app.get(PasswordService).hash(password);
  await db.$transaction(async tx => {
    await tx.user.create({ data: { id: userId, displayName: 'Auth integration', email, normalizedEmail: email,
      passwordCredential: { create: { passwordHash: hash } } } });
    await tx.user.create({ data: { id: otherId, displayName: 'Other', email: `${otherId}@example.test`, normalizedEmail: `${otherId}@example.test` } });
    for (const [organizationId, roleId, membershipId] of [[orgA, roleA, memberA], [orgB, roleB, memberB]]) {
      await tx.organization.create({ data: { id: organizationId, name: 'Auth integration', referenceCode: organizationId.toUpperCase(), status: 'ACTIVE' } });
      await tx.role.create({ data: { id: roleId, organizationId, name: 'Test custom role' } });
      await tx.organizationMembership.create({ data: { id: membershipId, organizationId, userId, roleId } });
    }
  });
  } catch { throw new Error('Falha segura ao preparar fixtures de autenticacao.'); }
});

after(async () => {
  try {
  if (db) {
    await db.$transaction(async tx => {
      await tx.refreshToken.deleteMany({ where: { session: { userId: { in: [userId, otherId] } } } });
      await tx.authSession.deleteMany({ where: { userId: { in: [userId, otherId] } } });
      await tx.passwordCredential.deleteMany({ where: { userId: { in: [userId, otherId] } } });
      await tx.organizationMembership.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
      await tx.role.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
      await tx.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
      await tx.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    });
    // Unique HMAC secret scopes every key to this process, including the shared loopback IP.
    const keys = [['login-ip', '127.0.0.1'], ['refresh-ip', '127.0.0.1'], ['logout-ip', '127.0.0.1'],
      ['login-email', email], ['login-email', `${otherId}@example.test`], ['login-email', 'absent@example.test'], ['test', userId]]
      .map(([scope, value]) => createHmac('sha256', config.rateKey).update(`${scope}\0${value}`).digest('hex'));
    await db.authRateLimit.deleteMany({ where: { key: { in: keys } } });
  }
  } catch { throw new Error('Falha segura ao remover fixtures de autenticacao.'); }
  finally { await app?.close(); }
});

test('auth: login correto, Argon2id e DTOs sem material secreto', async () => {
  const result = await request('/auth/login', { method: 'POST', body: { email: ` ${email.toUpperCase()} `, password } });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['accessToken', 'expiresIn', 'tokenType']);
  assert.equal(/HttpOnly/.test(result.headers.get('set-cookie')), true);
  assert.equal(/SameSite=Strict/.test(result.headers.get('set-cookie')), true);
  assert.equal(/Path=\/auth/.test(result.headers.get('set-cookie')), true);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const credential = await db.passwordCredential.findUnique({ where: { userId } });
  assert.equal(credential.passwordHash.startsWith('$argon2id$'), true);
  const me = await request('/auth/me', { token: result.body.accessToken });
  assert.deepEqual(Object.keys(me.body).sort(), ['displayName', 'email', 'id']);
  const claims = decodeJwt(result.body.accessToken);
  assert.equal('organizationId' in claims, false);
  const stored = await db.refreshToken.findUnique({ where: { tokenDigest: digest(result.cookie.split('=')[1]) } });
  assert.ok(stored);
});

test('auth: login inexistente, senha errada, identidade sem credencial e User bloqueado indistinguiveis', async () => {
  const responses = [];
  for (const data of [{ email: 'absent@example.test', password }, { email, password: 'incorrect' },
    { email: `${otherId}@example.test`, password }]) responses.push(await request('/auth/login', { method: 'POST', body: data }));
  await db.user.update({ where: { id: userId }, data: { status: 'BLOCKED' } });
  try { responses.push(await request('/auth/login', { method: 'POST', body: { email, password } })); }
  finally { await db.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } }); }
  for (const result of responses) { assert.equal(result.status, 401); assert.deepEqual(result.body, responses[0].body); }
});

test('auth: CSRF rejeita Origin ausente, null, hostil, header ausente e content-type simples', async () => {
  for (const extra of [{ Origin: '' }, { Origin: 'null' }, { Origin: 'https://evil.example' },
    { 'X-AgroTrack-CSRF': '' }, { 'Content-Type': 'text/plain' }]) {
    for (const path of ['/auth/login', '/auth/refresh', '/auth/logout']) {
      assert.equal((await request(path, { method: 'POST', body: { email, password }, extra })).status, 403);
    }
  }
});

test('auth: parser HTTP nao expoe fragmentos sensiveis e limita payload', async () => {
  const marker = randomBytes(16).toString('hex');
  for (const [body, status] of [[`{"password":"${marker}",`, 400], [JSON.stringify({ password: marker.repeat(1000) }), 413]]) {
    const result = await request('/auth/login', { method: 'POST', body });
    assert.equal(result.status, status);
    assert.equal(JSON.stringify(result.body).includes(marker), false);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
});

test('auth: token ausente, invalido, expirado, audience e algoritmo errados sao rejeitados', async () => {
  const { token } = await login(); const payload = decodeJwt(token);
  const tokens = ['', 'invalid', token.slice(0, -5) + 'xxxxx'];
  for (const [alg, audience, expires] of [['HS256', config.audience, -1], ['HS256', 'other', 100], ['HS384', config.audience, 100]]) {
    tokens.push(await new SignJWT({ sid: payload.sid }).setProtectedHeader({ alg, typ: 'at+jwt' })
      .setSubject(userId).setIssuer(config.issuer).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expires).sign(config.jwtKey));
  }
  for (const candidate of tokens) assert.equal((await request('/auth/me', { token: candidate })).status, 401);
  for (const [issuer, typ] of [['another-issuer', 'at+jwt'], [config.issuer, 'JWT']]) {
    const candidate = await new SignJWT({ sid: payload.sid }).setProtectedHeader({ alg: 'HS256', typ })
      .setSubject(userId).setIssuer(issuer).setAudience(config.audience).setIssuedAt().setExpirationTime('5m').sign(config.jwtKey);
    assert.equal((await request('/auth/me', { token: candidate })).status, 401);
  }
});

test('auth: User bloqueado nao renova refresh e sessao permanece revogada apos desbloqueio', async () => {
  const original = await login();
  await db.user.update({ where: { id: userId }, data: { status: 'BLOCKED' } });
  try { assert.equal((await request('/auth/refresh', { method: 'POST', cookie: original.cookie })).status, 401); }
  finally { await db.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } }); }
  assert.equal((await request('/auth/me', { token: original.token })).status, 401);
});

test('auth: sessao e User revalidados em toda requisicao', async () => {
  const { token } = await login(); const sessionId = decodeJwt(token).sid;
  await db.user.update({ where: { id: userId }, data: { status: 'BLOCKED' } });
  try { assert.equal((await request('/auth/me', { token })).status, 401); }
  finally { await db.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } }); }
  await db.authSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  assert.equal((await request('/auth/me', { token })).status, 401);
});

test('auth: contexto por requisicao aceita duas organizations sem mudar sessao e nao confia organizationId', async () => {
  const { token } = await login();
  const [a, b] = await Promise.all([request('/auth/context', { token, membership: memberA }), request('/auth/context', { token, membership: memberB })]);
  assert.equal(a.body.organizationId, orgA); assert.equal(b.body.organizationId, orgB);
  assert.equal(a.body.sessionId, b.body.sessionId);
  for (const membership of ['', randomUUID(), orgA, 'not-a-uuid']) assert.equal((await request('/auth/context', { token, membership })).status, 403);
  assert.equal((await request('/auth/context', { token, extra: { 'organizationId': orgA } })).status, 403);
  const list = await request('/auth/memberships', { token });
  assert.deepEqual(list.body.map(value => value.id).sort(), [memberA, memberB].sort());
  await db.organizationMembership.update({ where: { id: memberB }, data: { userId: otherId } });
  try { assert.equal((await request('/auth/context', { token, membership: memberB })).status, 403); }
  finally { await db.organizationMembership.update({ where: { id: memberB }, data: { userId } }); }
});

test('auth: membership, organization e role inativos rejeitam contexto e nao aparecem na lista', async () => {
  const { token } = await login();
  for (const [model, id, status] of [['organizationMembership', memberA, 'SUSPENDED'], ['organization', orgA, 'SUSPENDED'], ['role', roleA, 'INACTIVE']]) {
    await db[model].update({ where: { id }, data: { status } });
    try {
      assert.equal((await request('/auth/context', { token, membership: memberA })).status, 403);
      assert.equal((await request('/auth/memberships', { token })).body.some(value => value.id === memberA), false);
    } finally { await db[model].update({ where: { id }, data: { status: 'ACTIVE' } }); }
  }
});

test('auth: refresh rotaciona; reutilizacao revoga inclusive o token sucessor', async () => {
  const original = await login();
  const rotated = await request('/auth/refresh', { method: 'POST', cookie: original.cookie });
  assert.equal(rotated.status, 200); assert.equal(rotated.cookie !== original.cookie, true);
  assert.equal((await request('/auth/refresh', { method: 'POST', cookie: original.cookie })).status, 401);
  assert.equal((await request('/auth/me', { token: rotated.body.accessToken })).status, 401);
  assert.equal((await request('/auth/refresh', { method: 'POST', cookie: rotated.cookie })).status, 401);
  assert.equal((await request('/auth/refresh', { method: 'POST', cookie: 'agrotrack_refresh=invalid' })).status, 401);
});

test('auth: refresh concorrente tem um vencedor e replay revoga a sessao', async () => {
  const original = await login();
  const results = await Promise.all([1, 2].map(() => request('/auth/refresh', { method: 'POST', cookie: original.cookie })));
  assert.deepEqual(results.map(value => value.status).sort(), [200, 401]);
  assert.equal((await request('/auth/me', { token: results.find(value => value.status === 200).body.accessToken })).status, 401);
});

test('auth: logout revoga e limpa cookie, inclusive concorrente com refresh', async () => {
  const original = await login();
  const [logout] = await Promise.all([request('/auth/logout', { method: 'POST', cookie: original.cookie }),
    request('/auth/refresh', { method: 'POST', cookie: original.cookie })]);
  assert.equal(logout.status, 204);
  assert.equal(/Expires=Thu, 01 Jan 1970/.test(logout.headers.get('set-cookie')), true);
  assert.equal((await request('/auth/me', { token: original.token })).status, 401);
  assert.equal((await request('/auth/refresh', { method: 'POST', cookie: original.cookie })).status, 401);
});

test('auth: refresh expirado e sessao expirada rejeitados sem estender validade absoluta', async () => {
  const original = await login(); const id = decodeJwt(original.token).sid;
  const past = new Date(Date.now() - 10000), older = new Date(Date.now() - 20000);
  await db.refreshToken.updateMany({ where: { sessionId: id }, data: { createdAt: older, expiresAt: past } });
  assert.equal((await request('/auth/refresh', { method: 'POST', cookie: original.cookie })).status, 401);
  const second = await login(); const sid = decodeJwt(second.token).sid;
  await db.authSession.update({ where: { id: sid }, data: { createdAt: older, expiresAt: past } });
  assert.equal((await request('/auth/me', { token: second.token })).status, 401);
  assert.equal((await request('/auth/refresh', { method: 'POST', cookie: second.cookie })).status, 401);
  const third = await login(); const thirdId = decodeJwt(third.token).sid;
  const expiry = new Date(Date.now() + 10000);
  await db.authSession.update({ where: { id: thirdId }, data: { expiresAt: expiry } });
  const result = await request('/auth/refresh', { method: 'POST', cookie: third.cookie });
  assert.equal(result.status, 200);
  const rows = await db.refreshToken.findMany({ where: { sessionId: thirdId, consumedAt: null } });
  assert.ok(rows[0].expiresAt <= expiry);
});

test('auth: rate limiter PostgreSQL atomico entre instancias e sem identificador bruto', async () => {
  const one = app.get(RateLimitService), two = new RateLimitService(db, config);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => (index % 2 ? one : two).consume('test', userId, 3)));
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 3);
  for (const result of results.filter(value => value.status === 'rejected')) assert.equal(result.reason.getStatus(), 429);
  const key = createHmac('sha256', config.rateKey).update(`test\0${userId}`).digest('hex');
  const row = await db.authRateLimit.findUnique({ where: { key } });
  assert.equal(row.attempts, 4);
});

test('auth: health publico continua operacional', async () => {
  const result = await request('/health');
  assert.deepEqual(result.body, { status: 'ok', api: 'operational', database: 'connected' });
});

test('auth: configuracao rejeita secrets ausentes, origem wildcard/HTTP producao e TTL invalido', () => {
  for (const [key, value] of [['AUTH_JWT_SECRET', ''], ['AUTH_RATE_LIMIT_SECRET', 'placeholder'],
    ['AUTH_ALLOWED_ORIGINS', '*'], ['AUTH_ACCESS_TTL_SECONDS', '99999']]) {
    const original = process.env[key]; process.env[key] = value;
    try { assert.throws(() => new AuthConfig()); } finally {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
    }
  }
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => new AuthConfig());
    process.env.AUTH_ALLOWED_ORIGINS = 'https://app.example.test';
    const production = new AuthConfig();
    assert.equal(production.production, true); assert.equal(production.cookieName.startsWith('__Secure-'), true);
  } finally { process.env.NODE_ENV = 'test'; process.env.AUTH_ALLOWED_ORIGINS = origin; }
});

test('auth: CORS exato com credentials, preflight sem autorizar origem hostil', async () => {
  for (const allowed of [true, false]) {
    const response = await fetch(`${base}/auth/refresh`, { method: 'OPTIONS', headers: {
      Origin: allowed ? origin : 'https://evil.example', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-agrotrack-csrf',
    } });
    assert.equal(response.headers.get('access-control-allow-origin'), allowed ? origin : null);
    if (allowed) assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  }
});

test('auth: cookie producao e limpeza preservam atributos seguros no HTTP Nest real', async () => {
  let productionApp;
  const previousEnvironment = process.env.NODE_ENV;
  const previousOrigins = process.env.AUTH_ALLOWED_ORIGINS;
  process.env.NODE_ENV = 'production';
  process.env.AUTH_ALLOWED_ORIGINS = 'https://app.example.test';
  try {
    productionApp = await NestFactory.create(AppModule, { logger: false, abortOnError: false, bodyParser: false });
    configureHttp(productionApp);
    await productionApp.listen(0, '127.0.0.1');
    const productionBase = await productionApp.getUrl();
    // Local HTTP transport only inspects server headers; this does not test TLS or browser cookie storage.
    const productionHeaders = { ...headers, Origin: 'https://app.example.test' };
    const result = await fetch(`${productionBase}/auth/login`, { method: 'POST', headers: productionHeaders,
      body: JSON.stringify({ email, password }) });
    assert.equal(result.status, 200);
    const cookie = result.headers.get('set-cookie') ?? '';
    const checkAttributes = value => {
      for (const pattern of [/^__Secure-agrotrack_refresh=/, /; Secure(?:;|$)/, /; HttpOnly(?:;|$)/,
        /; SameSite=Strict(?:;|$)/, /; Path=\/auth(?:;|$)/]) assert.equal(pattern.test(value), true);
      assert.equal(/; Domain=/i.test(value), false);
    };
    checkAttributes(cookie);
    await result.arrayBuffer();
    const logout = await fetch(`${productionBase}/auth/logout`, { method: 'POST',
      headers: { ...productionHeaders, Cookie: cookie.split(';')[0] }, body: '{}' });
    assert.equal(logout.status, 204);
    const cleared = logout.headers.get('set-cookie') ?? '';
    checkAttributes(cleared);
    assert.equal(/^__Secure-agrotrack_refresh=;/.test(cleared), true);
    assert.equal(/Expires=Thu, 01 Jan 1970/.test(cleared), true);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    // Deliberately omit cause: database/HTTP errors may contain credentials or tokens.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Falha segura no teste HTTP de cookie de producao.');
  } finally {
    process.env.NODE_ENV = previousEnvironment;
    process.env.AUTH_ALLOWED_ORIGINS = previousOrigins;
    await productionApp?.close();
  }
});

test('auth: limite HTTP por IP nao pode ser evitado com X-Forwarded-For', async () => {
  const key = createHmac('sha256', config.rateKey).update('login-ip\0' + '127.0.0.1').digest('hex');
  await db.authRateLimit.update({ where: { key }, data: { attempts: config.loginIpLimit } });
  const result = await request('/auth/login', { method: 'POST', body: { email, password }, extra: { 'X-Forwarded-For': '203.0.113.99' } });
  assert.equal(result.status, 429); assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('auth: banco rejeita credencial sem Argon2id e refresh sem sessao', async () => {
  for (const operation of [tx => tx.passwordCredential.create({ data: { userId: otherId, passwordHash: 'not-a-hash' } }),
    tx => tx.refreshToken.create({ data: { sessionId: randomUUID(), tokenDigest: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 10000) } })]) {
    let rejected = false;
    try { await db.$transaction(operation); } catch { rejected = true; }
    assert.equal(rejected, true);
  }
});
