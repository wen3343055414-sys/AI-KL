import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { AdminStore, HttpError } from './store.js';
import { KeyVault } from './key-vault.js';
import { listenOptions, readSecret, serviceOrigin } from '../../src/config.js';
import os from 'node:os';
import { ModelRegistry } from './model-registry.js';
import { ModelGateway } from './model-gateway.js';
import { WebsiteStore, createWebsiteServer } from './websites.js';
import { generateWebsite } from './website-generator.js';
import { DomainRegistry } from './domain-registry.js';

const CODE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = CODE_ROOT;
const COOKIE = 'ai_wqs_admin_session';
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/api-settings.js', ['api-settings.js', 'text/javascript; charset=utf-8']], ['/websites.js', ['websites.js', 'text/javascript; charset=utf-8']], ['/websites.css', ['websites.css', 'text/css; charset=utf-8']], ['/models.css', ['models.css', 'text/css; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
function tokenFrom(request) {
  return request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
}
async function body(request, limit = 8192) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, '请使用 JSON 请求。');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; }
  catch { throw new HttpError(400, '请求格式不正确。'); }
}
function sameToken(left, right) {
  return typeof right === 'string' && /^[a-f0-9]{48}$/.test(right) && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
export function createAdminServer({ root = ROOT, settings, store = new AdminStore(path.join(root, 'data')), modelSettings = new ModelRegistry(store, new KeyVault()), modelGateway = new ModelGateway(store, modelSettings, settings.bridgeToken || ''), websites = new WebsiteStore(store), websiteRuntime, domains = new DomainRegistry(store, { workbenchOrigin: settings.workbenchOrigin }) }) {
  let addressPort = settings.port;
  const attempts = new Map();
  let hashing = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const websiteOrigin = websiteRuntime?.origin ? serviceOrigin(websiteRuntime.origin, '网站来源') : "'none'";
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${websiteOrigin}; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`);
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    try {
      const allowedHosts = new Set([`127.0.0.1:${addressPort}`, `localhost:${addressPort}`, `[::1]:${addressPort}`, ...(settings.allowedHosts || []), ...(settings.publicOrigin ? [new URL(settings.publicOrigin).host] : [])]);
      if (!allowedHosts.has(request.headers.host)) throw new HttpError(421, '请通过配置的管理地址访问。');
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = url.pathname;
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) throw new HttpError(405, '不支持此请求方法。');
      if (pathname.startsWith('/internal/model/')) {
        if (request.headers.origin || request.headers['sec-fetch-site'] || !modelGateway.authorized(request.headers['x-model-bridge'])) throw new HttpError(403, '模型桥接认证失败。');
        if (pathname === '/internal/model/config' && request.method === 'GET') return send(200, modelGateway.config());
        if (pathname === '/internal/model/chat' && request.method === 'POST') {
          const input = await body(request, 600_000);
          return send(200, await modelGateway.chat(input));
        }
        throw new HttpError(404, '接口不存在。');
      }
      if (pathname === '/api/health' && request.method === 'GET') {
        const hosting = websiteRuntime?.status();
        return send(200, { status: 'ok', mode: 'admin', version: '1.5.0', revision: settings.revision || 'development',
          ...(hosting ? { websites: { available: hosting.available, origin: hosting.origin, state: hosting.state } } : {}) });
      }
      const token = tokenFrom(request);
      const session = store.session(token);
      if (pathname === '/api/session' && request.method === 'GET') return send(200, { setupRequired: !store.hasOwner(), authenticated: Boolean(session), csrf: session?.csrf, product: '智作台服务端', port: addressPort });
      if (request.method === 'POST') {
        const expected = settings.publicOrigin || `http://${request.headers.host}`;
        if (request.headers.origin !== expected || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '请求来源验证失败，请在管理页面操作。');
      }
      if (['/api/setup', '/api/login'].includes(pathname) && request.method === 'POST') {
        const input = await body(request);
        const key = request.socket.remoteAddress || 'local';
        const previous = attempts.get(key);
        const attempt = previous && Date.now() - previous.since < 15 * 60_000 ? previous : { count: 0, since: Date.now() };
        if (attempt.count >= 10) throw new HttpError(429, '尝试次数过多，请在 15 分钟后重试。');
        if (hashing >= 2) throw new HttpError(429, '正在验证其他登录，请稍后重试。');
        hashing++;
        try {
          if (pathname === '/api/setup') await store.setup(input.password);
          else if (!(await store.checkPassword(input.password))) {
            attempt.count++;
            attempts.set(key, attempt);
            store.audit('login', 'failed', '密码不正确');
            throw new HttpError(401, '管理密码不正确。');
          }
          attempts.delete(key);
          const created = store.createSession();
          response.setHeader('Set-Cookie', `${COOKIE}=${created.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${settings.cookieSecure ? '; Secure' : ''}`);
          store.audit('login', 'success');
          return send(200, { authenticated: true, csrf: created.csrf });
        } finally { hashing--; }
      }
      if (pathname.startsWith('/api/')) {
        if (!session) throw new HttpError(401, '请先登录管理后台。');
        if (request.method === 'POST' && !sameToken(session.csrf, request.headers['x-admin-csrf'])) throw new HttpError(403, '登录校验已失效，请刷新后重试。');
        if (pathname === '/api/logout' && request.method === 'POST') {
          store.logout(token);
          response.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${settings.cookieSecure ? '; Secure' : ''}`);
          return send(200, { ok: true });
        }
        if (pathname === '/api/overview' && request.method === 'GET') return send(200, {
          updatedAt: new Date().toISOString(), appUrl: settings.workbenchOrigin || null,
          runtime: { platform: os.platform(), nodeVersion: process.version, uptimeSeconds: process.uptime(),
            memoryBytes: process.memoryUsage().rss, revision: settings.revision || 'development' },
          audit: store.audits(), modelUsage: modelGateway.usage(),
        });
        if (pathname === '/api/model-usage' && request.method === 'GET') return send(200, modelGateway.usage());
        if (pathname === '/api/domains' && request.method === 'GET') return send(200, { domains: domains.list() });
        if (pathname === '/api/domains' && request.method === 'POST') return send(201, domains.add(await body(request)));
        const domainRoute = pathname.match(/^\/api\/domains\/(domain_[a-f0-9]{24})(?:\/(verify|default|delete))?$/);
        if (domainRoute && request.method === 'POST') {
          const [, id, action] = domainRoute, input = await body(request);
          if (action === 'verify') return send(200, await domains.verify(id, input));
          if (action === 'default') return send(200, domains.setDefault(id, input));
          if (action === 'delete') { domains.remove(id, input); return send(200, { ok: true }); }
          return send(200, domains.save(id, input));
        }
        if (pathname === '/api/websites' && request.method === 'GET') return send(200, { sites: websites.list(), hosting: websiteRuntime?.status() || { origin: null, available: false, state: 'stopped' }, models: modelGateway.config() });
        if (pathname === '/api/websites' && request.method === 'POST') return send(201, websites.create(await body(request, 8_000_000)));
        const websiteRoute = pathname.match(/^\/api\/websites\/(site_[a-f0-9]+)(?:\/(publish|unpublish|delete|preview|generate|export))?$/);
        if (websiteRoute) {
          const [, id, action] = websiteRoute;
          if (!action && request.method === 'GET') return send(200, websites.get(id));
          if (action === 'export' && request.method === 'GET') {
            const site = websites.get(id);
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${site.slug}.json"` });
            return response.end(JSON.stringify({ schemaVersion: 1, name: site.name, slug: site.slug, description: site.description, files: site.files }, null, 2));
          }
          if (request.method === 'POST') {
            const input = await body(request, action === 'generate' ? 120_000 : 8_000_000);
            if (!action) return send(200, websites.save(id, input));
            if (action === 'publish') {
              if (!websiteRuntime?.available) throw new HttpError(503, '网站访客服务不可用，未发布。');
              return send(200, websites.publish(id, input));
            }
            if (action === 'unpublish') return send(200, websites.unpublish(id, input));
            if (action === 'delete') { websites.remove(id, input); return send(200, { ok: true }); }
            if (action === 'preview') {
              if (!websiteRuntime?.available) throw new HttpError(503, '网站访客服务不可用，无法预览。');
              const preview = websites.preview(id, input);
              return send(200, { ...preview, url: websiteRuntime.origin + preview.path });
            }
            if (action === 'generate') {
              const current = websites.get(id);
              const generated = await generateWebsite(modelGateway, current, input);
              return send(200, { site: websites.save(id, { ...current, files: generated.files, revision: input.revision }), model: generated.model });
            }
          }
          throw new HttpError(405, '不支持此网站操作。');
        }
        if (pathname === '/api/model-settings' && request.method === 'GET') return send(200, modelSettings.read());
        if (pathname === '/api/model-settings' && request.method === 'POST') return send(200, await modelSettings.save(await body(request)));
        if (pathname === '/api/model-settings/test' && request.method === 'POST') return send(200, await modelSettings.test((await body(request)).revision));
        if (pathname === '/api/model-providers' && request.method === 'GET') return send(200, modelSettings.list());
        if (pathname === '/api/model-providers' && request.method === 'POST') return send(200, await modelSettings.saveProvider(null, await body(request)));
        if (pathname === '/api/model-routing' && request.method === 'POST') { const input = await body(request); return send(200, modelSettings.setDefault(input.modelKey, input.revision)); }
        const providerRoute = pathname.match(/^\/api\/model-providers\/(provider_[A-Za-z0-9_-]+)(?:\/(test|models|delete))?$/);
        if (providerRoute && request.method === 'POST') {
          const [, id, action] = providerRoute, input = await body(request);
          if (action === 'test') return send(200, await modelSettings.testProvider(id, input.revision));
          if (action === 'models') return send(200, modelSettings.addModel(id, input));
          if (action === 'delete') { modelSettings.removeProvider(id, input.revision, input.confirmation); return send(200, { ok: true }); }
          return send(200, await modelSettings.saveProvider(id, input));
        }
        const modelRoute = pathname.match(/^\/api\/model-catalog\/(model_[A-Za-z0-9_-]+)(?:\/(delete))?$/);
        if (modelRoute && request.method === 'POST') {
          const [, id, action] = modelRoute, input = await body(request);
          if (action === 'delete') { modelSettings.removeModel(id, input.revision, input.confirmation); return send(200, { ok: true }); }
          return send(200, modelSettings.updateModel(id, input));
        }
        throw new HttpError(404, '接口不存在。');
      }
      const asset = assets.get(pathname);
      if (!asset || !['GET', 'HEAD'].includes(request.method)) throw new HttpError(404, '页面不存在。');
      const content = await readFile(path.join(settings.codeRoot || root, 'public', asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (!error.status) console.error(new Date().toISOString(), 'Request error:', error.message);
      send(error.status || 503, { message: error.status ? error.message : '暂时无法读取服务状态，请查看管理服务日志。', ...(error.code && error.status ? { code: error.code } : {}) });
    }
  });
  server.on('listening', () => { addressPort = server.address().port; });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, store, websites };
}

async function main() {
  process.umask(0o077);
  const listener = listenOptions(process.env.ADMIN_HOST ?? '0.0.0.0', process.env.ADMIN_PORT ?? '3100', '管理服务');
  const publicOrigin = process.env.ADMIN_ORIGIN ? serviceOrigin(process.env.ADMIN_ORIGIN, 'ADMIN_ORIGIN') : undefined;
  const workbenchOrigin = serviceOrigin(process.env.WORKBENCH_ORIGIN || 'http://127.0.0.1:3000', 'WORKBENCH_ORIGIN');
  const settings = { port: listener.port, publicOrigin, workbenchOrigin, codeRoot: CODE_ROOT,
    revision: process.env.APP_VERSION || 'development', cookieSecure: publicOrigin?.startsWith('https:') || process.env.COOKIE_SECURE === 'true',
    allowedHosts: (process.env.ADMIN_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean),
    bridgeToken: process.env.MODEL_BRIDGE_TOKEN || process.env.MODEL_BRIDGE_TOKEN_FILE
      ? await readSecret(process.env.MODEL_BRIDGE_TOKEN, process.env.MODEL_BRIDGE_TOKEN_FILE, 'MODEL_BRIDGE_TOKEN') : '' };
  const directory = path.resolve(process.env.ADMIN_DATA_DIR || path.join(ROOT, 'data'));
  const store = new AdminStore(directory), websites = new WebsiteStore(store), domains = new DomainRegistry(store, { workbenchOrigin });
  const listeners = [];
  let websiteRuntime;
  if (process.env.WEBSITE_PORT) {
    const visitorOptions = listenOptions(process.env.WEBSITE_HOST ?? '0.0.0.0', process.env.WEBSITE_PORT, '网站访客服务');
    if (visitorOptions.port && visitorOptions.port === listener.port) throw new Error('网站访客端口不能与管理端口相同。');
    const origin = serviceOrigin(process.env.WEBSITE_ORIGIN, 'WEBSITE_ORIGIN');
    if (origin === publicOrigin || origin === workbenchOrigin) throw new Error('网站内容需要使用独立来源。');
    websiteRuntime = { available: false, origin, status() { return { available: this.available, origin: this.origin, state: this.available ? 'ready' : 'stopped' }; } };
    const visitor = createWebsiteServer({ websites, hostname: new URL(origin).hostname });
    visitor.on('listening', () => { websiteRuntime.available = true; });
    visitor.on('error', error => { websiteRuntime.available = false; console.error('网站访客服务错误：', error.message); });
    visitor.listen(visitorOptions.port, visitorOptions.host);
    listeners.push(visitor);
  }
  const { server } = createAdminServer({ store, websites, domains, websiteRuntime, settings });
  listeners.push(server);
  server.listen(listener.port, listener.host, () => {
    const address = server.address();
    const hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
    console.log(`智作台管理服务 running at http://${hostname}:${address.port}`);
  });
  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return; stopping = true;
    const timeout = setTimeout(() => process.exit(1), 7000); timeout.unref();
    await Promise.all(listeners.map(listener => new Promise(resolve => { listener.close(resolve); listener.closeIdleConnections(); })));
    store.close(); process.exit(code);
  }
  server.on('error', error => { console.error(error.message); shutdown(1).catch(() => process.exit(1)); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { shutdown().catch(() => process.exit(1)); });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
