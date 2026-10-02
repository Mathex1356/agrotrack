import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDatabaseUrl, getPort } from '../dist/config/environment.js';
import { HealthController } from '../dist/health.controller.js';

test('configuração rejeita URL ausente, inválida e placeholder sem expor valores', () => {
  const original = process.env.DATABASE_URL;
  try {
    for (const value of ['', 'invalid-sensitive-value', 'https://example.com/db',
      'postgresql://local:SUBSTITUA_POR_UMA_SENHA_LOCAL@localhost/db']) {
      process.env.DATABASE_URL = value;
      assert.throws(() => getDatabaseUrl(), (error) => {
        assert.match(error.message, /DATABASE_URL/);
        assert.ok(!error.message.includes('invalid-sensitive-value'));
        assert.ok(!error.message.includes('SUBSTITUA_POR_UMA_SENHA_LOCAL'));
        return true;
      });
    }
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});

test('configuração rejeita portas fora do intervalo', () => {
  const original = process.env.PORT;
  try {
    for (const value of ['0', '65536', 'abc']) {
      process.env.PORT = value;
      assert.throws(() => getPort(), /PORT/);
    }
  } finally {
    if (original === undefined) delete process.env.PORT;
    else process.env.PORT = original;
  }
});

test('health aguarda uma consulta real ao provider antes de indicar conectado', async () => {
  let complete;
  const query = new Promise(resolve => { complete = resolve; });
  const controller = new HealthController({ $queryRaw: () => query });
  let responded = false;
  const response = controller.getHealth().then(value => { responded = true; return value; });
  await Promise.resolve();
  assert.equal(responded, false);
  complete([{ value: 1 }]);
  assert.deepEqual(await response, { status: 'ok', api: 'operational', database: 'connected' });
});

test('falha no banco produz 503 sem incluir informações do erro original', async () => {
  const controller = new HealthController({
    $queryRaw: () => Promise.reject(new Error('sensitive-connection-details')),
  });
  await assert.rejects(() => controller.getHealth(), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(error.getResponse(), {
      status: 'degraded', api: 'operational', database: 'disconnected',
    });
    assert.ok(!JSON.stringify(error.getResponse()).includes('sensitive-connection-details'));
    return true;
  });
});
