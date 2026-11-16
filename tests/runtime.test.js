import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const PASSWORD = 'fixture-portable-admin-password';

async function start(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errorText = '';
  child.stderr.on('data', chunk => { errorText += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Service startup timed out: ${errorText}`)); }, 5000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/[\w.]+:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0].replace('0.0.0.0', '127.0.0.1')); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Service exited (${code}): ${errorText}`)); });
  });
  return { base, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close'); child.kill(); await closed;
  } };
}

// Raw HTTP lets this stand in for a TLS-terminating proxy without disabling TLS
// verification or trusting arbitrary X-Forwarded-* headers in the application.
function proxyRequest(base, url, { host, origin, cookie = '', csrf = '', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(base + url, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Host: host || new URL(base).host, Cookie: cookie,
        ...(origin ? { Origin: origin } : {}),
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Admin-CSRF': csrf }) },
    }, response => {
      let content = ''; response.setEncoding('utf8'); response.on('data', chunk => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(content) }));
    });
    request.on('error', reject); request.end(payload);
  });
}

test('environment-only admin starts behind an HTTPS origin and preserves credentials and sessions on restart', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'portable-runtime-'));
  const env = { ADMIN_HOST: '127.0.0.1', ADMIN_PORT: '0', ADMIN_DATA_DIR: directory,
    ADMIN_ORIGIN: 'https://admin.fixture.test', ADMIN_ALLOWED_HOSTS: 'models.fixture.test',
    MODEL_BRIDGE_TOKEN: randomBytes(32).toString('hex'), MODEL_BRIDGE_TOKEN_FILE: '',
    SECRET_ENCRYPTION_KEY: randomBytes(32).toString('hex'), SECRET_ENCRYPTION_KEY_FILE: '',
    WORKBENCH_ORIGIN: 'https://workbench.fixture.test', WEBSITE_PORT: '', APP_VERSION: 'portable-fixture' };
  let service = await start('admin/src/server.js', env);
  t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
  const origin = env.ADMIN_ORIGIN, host = 'admin.fixture.test';
  assert.equal((await proxyRequest(service.base, '/api/health', { host: 'foreign.fixture.test' })).status, 421);
  assert.equal((await proxyRequest(service.base, '/api/health', { host: 'models.fixture.test' })).status, 200);
  assert.equal((await proxyRequest(service.base, '/api/setup', { host, origin: 'http://admin.fixture.test', body: { password: PASSWORD } })).status, 403);
  const setup = await proxyRequest(service.base, '/api/setup', { host, origin, body: { password: PASSWORD } });
  assert.equal(setup.status, 200); assert.match(setup.headers['set-cookie'][0], /; Secure/);
  const cookie = setup.headers['set-cookie'][0].split(';')[0], csrf = setup.data.csrf;
  const provider = await proxyRequest(service.base, '/api/model-providers', { host, origin, cookie, csrf, body: {
    name: 'Portable fixture', preset: 'custom', protocol: 'openai', baseUrl: 'https://provider.fixture.test/v1',
    authMode: 'bearer', apiKey: 'fixture-portable-provider-key', timeoutSeconds: 5, monthlyTokenLimit: 0, enabled: true, revision: 0,
  } });
  assert.equal(provider.status, 200); assert.equal(provider.data.hasApiKey, true);
  assert.ok(!JSON.stringify(provider.data).includes('fixture-portable-provider-key'));
  await service.stop(); service = await start('admin/src/server.js', env);
  const listing = await proxyRequest(service.base, '/api/model-providers', { host, origin, cookie });
  assert.equal(listing.status, 200); assert.equal(listing.data.providers[0].id, provider.data.id);
  const overview = await proxyRequest(service.base, '/api/overview', { host, origin, cookie });
  assert.equal(overview.data.runtime.revision, 'portable-fixture');
  assert.equal(overview.data.appUrl, env.WORKBENCH_ORIGIN);
  assert.equal((await proxyRequest(service.base, '/api/actions', { host, origin, cookie, csrf, body: {} })).status, 404);
});

test('model client uses the configured gateway Host and environment token without a machine token file', async t => {
  const { WorkspaceStore } = await import('../src/store.js');
  const { ModelClient } = await import('../src/model-client.js');
  const directory = await mkdtemp(path.join(tmpdir(), 'portable-gateway-'));
  const store = new WorkspaceStore(directory), token = randomBytes(32).toString('hex');
  let expectedHost;
  const gateway = createServer((req, res) => {
    assert.equal(req.headers.host, expectedHost);
    assert.equal(req.headers['x-model-bridge'], token);
    res.end(JSON.stringify({ ready: true, model: 'fixture' }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); }); store.close(); await rm(directory, { recursive: true, force: true }); });
  expectedHost = `localhost:${gateway.address().port}`;
  const client = new ModelClient(store, { baseUrl: `http://${expectedHost}/internal/model`, token, tokenFile: '' });
  assert.equal((await client.config()).ready, true);
  const invalid = new ModelClient(store, { baseUrl: `ftp://${expectedHost}/internal/model`, token, tokenFile: '' });
  assert.equal((await invalid.config()).ready, false);
});
