import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdminStore } from '../src/store.js';
import { DomainRegistry } from '../src/domain-registry.js';
import { createAdminServer } from '../src/server.js';

test('domain administration preserves revisions and verification without a machine gateway', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'domain-api-'));
  const store = new AdminStore(directory);
  const domains = new DomainRegistry(store, { workbenchOrigin: 'https://workbench.my-real-site.com', verifier: async () => ({ state: 'pending', message: 'fixture pending' }) });
  const { server } = createAdminServer({ settings: { port: 0 }, store, domains });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); store.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';
  const request = async (url, value) => {
    const response = await fetch(base + url, { method: value ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf }, body: value && JSON.stringify(value) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json(); if (data.csrf) csrf = data.csrf;
    return { status: response.status, data };
  };
  assert.equal((await request('/api/domains')).status, 401);
  assert.equal((await request('/api/setup', { password: 'fixture-admin-password' })).status, 200);
  let domain = (await request('/api/domains', { hostname: 'Portal.my-real-site.com' })).data;
  assert.equal(domain.hostname, 'portal.my-real-site.com'); assert.equal(domain.verification.state, 'pending');
  domain = (await request(`/api/domains/${domain.id}/verify`, { revision: domain.revision })).data;
  assert.equal(domain.verification.state, 'pending'); assert.equal(domains.defaultOrigin(), null);
  assert.equal((await request(`/api/domains/${domain.id}`, { revision: domain.revision - 1, enabled: false })).status, 409);
  assert.equal((await request('/api/domains')).data.domains.length, 1);
  for (const endpoint of ['/api/domain-access', '/api/domain-access/check', '/api/website-hosting/start']) assert.equal((await request(endpoint, {})).status, 404);
});
