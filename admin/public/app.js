import { initApiSettings } from './api-settings.js';
import { initWebsites } from './websites.js';
const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number = value => new Intl.NumberFormat('zh-CN').format(value || 0);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const pages = {
  overview: ['服务器总览', 'SERVER OVERVIEW', '查看服务状态与模型用量。'],
  audit: ['操作记录', 'ACTIVITY HISTORY', '管理操作有记录，运行过程可追溯。'],
  'api-settings': ['API 接口设置', 'MODEL API SETTINGS', '统一管理服务商连接与工作台可选模型。'],
  websites: ['域名与网站', 'DOMAINS & WEBSITES', '管理工作台域名与 HTTPS 验证。'],
};
let csrf = '', setupRequired = false, authenticated = false, currentPage = 'overview';
let report = null, refreshPending = false, toastTimer;
const date = (value, compact = false) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(compact ? {} : { year: 'numeric', second: '2-digit' }), hour12: false }).format(parsed);
};
function bytes(value, precision = 1) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let result = value / 1024, unit = 0;
  while (result >= 1024 && unit < units.length - 1) { result /= 1024; unit++; }
  return `${result.toFixed(precision)} ${units[unit]}`;
}
async function api(url, options = {}) {
  const headers = { ...(options.method === 'POST' ? { 'Content-Type': 'application/json', 'X-Admin-CSRF': csrf } : {}), ...options.headers };
  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && authenticated) { authenticated = false; showAuth(false); }
    throw new Error(data.message || '请求未完成，请稍后重试。');
  }
  return data;
}
function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
function showAuth(setup) {
  setupRequired = setup; $('auth-view').hidden = false; $('app-view').hidden = true; $('auth-form').hidden = false;
  $('confirm-field').hidden = !setup; $('password-confirm').required = setup;
  $('password').setAttribute('autocomplete', setup ? 'new-password' : 'current-password');
  $('auth-title').textContent = setup ? '设置管理后台密码' : '欢迎回到管理后台';
  $('auth-description').textContent = setup ? '首次使用，为独立管理服务设置一个 10–128 位密码。' : '输入独立管理密码，查看并管理模型服务。';
  $('auth-submit').textContent = setup ? '设置密码并进入后台 →' : '进入管理后台 →';
}
async function enter() {
  authenticated = true; $('auth-view').hidden = true; $('app-view').hidden = false;
  const requested = location.hash.slice(1); navigate(pages[requested] ? requested : 'overview');
  await refresh();
}
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('auth-error').textContent = '';
  const password = $('password').value;
  if (setupRequired && password !== $('password-confirm').value) { $('auth-error').textContent = '两次输入的密码不一致。'; return; }
  $('auth-submit').disabled = true;
  try {
    const result = await api(setupRequired ? '/api/setup' : '/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    csrf = result.csrf; $('password').value = ''; $('password-confirm').value = ''; await enter();
  } catch (error) { $('auth-error').textContent = error.message; }
  finally { $('auth-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => { if (currentPage === 'websites' && !websiteUI.canLeave()) return; try { await api('/api/logout', { method: 'POST', body: '{}' }); authenticated = false; csrf = ''; showAuth(false); } catch (error) { toast(error.message); } });
function navigate(page) {
  if (!pages[page]) return;
  if (currentPage === 'websites' && page !== currentPage && !websiteUI.canLeave()) return;
  currentPage = page;
  $('app-view').classList.toggle('domains-mode', page === 'websites');
  document.querySelectorAll('.page-panel').forEach(node => { node.hidden = node.id !== `page-${page}`; });
  document.querySelectorAll('.nav-item').forEach(node => { const selected = node.dataset.page === page; node.classList.toggle('active', selected); node.setAttribute('aria-current', selected ? 'page' : 'false'); });
  const [title, eyebrow, description] = pages[page];
  $('page-title').textContent = $('breadcrumb-page').textContent = title;
  $('page-eyebrow').textContent = eyebrow; $('page-description').textContent = description;
  document.title = `${title} · 智作台服务端`; history.replaceState(null, '', `#${page}`);
  if (page === 'api-settings' && authenticated) modelUI.load();
  if (page === 'websites' && authenticated) websiteUI.load();
}
document.addEventListener('click', event => {
  const navigation = event.target.closest('[data-page]');
  if (navigation) navigate(navigation.dataset.page);
});
function badge(element, text, type) { element.textContent = text; element.className = `badge ${type}`; }
function renderModelUsage(usage) {
  if (!usage) return;
  const { model, today, total } = usage;
  badge($('model-ready-badge'), model.ready ? '真实模型已配置' : '等待配置', model.ready ? 'success' : 'warning');
  $('model-active-description').textContent = model.ready ? `${model.provider} · ${model.model} · 保存配置后自动同步到工作台` : model.message;
  $('token-today').textContent = number(today.totalTokens);
  $('token-total').textContent = number(total.totalTokens);
  $('token-today-requests').textContent = `今日 ${number(today.requests)} 次请求 · 北京时间`;
  $('token-total-requests').textContent = usage.since ? `共 ${number(total.requests)} 次 · 起始 ${date(usage.since, true)}` : '首次请求后开始累计';
  $('token-input-output').textContent = `${number(total.promptTokens)} / ${number(total.completionTokens)}`;
  $('token-cached').textContent = `输入缓存命中 ${number(total.cachedTokens)} Token（已包含在输入中）`;
  $('token-results').textContent = `${number(total.succeeded)} 成功 / ${number(total.failed)} 失败`;
  const unknown = total.requests - total.meteredRequests;
  $('token-missing').textContent = `${number(total.pending)} 次进行中 · ${number(unknown)} 次未取得用量`;
  $('token-recent').innerHTML = usage.recent.length ? usage.recent.map(item => `<tr><td>${date(item.time, true)}${item.error ? `<small title="${escape(item.error)}">${escape(item.error)}</small>` : ''}</td><td class="mono">${escape(item.model)}</td><td><span class="badge ${item.status === 'success' ? 'success' : item.status === 'failed' ? 'failed' : 'neutral'}">${({ success: '已回复', failed: '失败', pending: '进行中', unknown: '结果未确认' })[item.status]}</span></td><td>${item.promptTokens === null ? '—' : number(item.promptTokens)}</td><td>${item.completionTokens === null ? '—' : number(item.completionTokens)}</td><td>${item.totalTokens === null ? '—' : number(item.totalTokens)}</td><td>${item.latencyMs === null ? '—' : `${(item.latencyMs / 1000).toFixed(1)} s`}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">尚无模型请求。前往工作台发送第一条消息。</td></tr>';
}
function render() {
  const { runtime, audit, modelUsage } = report;
  renderModelUsage(modelUsage); modelUI.updateUsage(modelUsage);
  $('node-address').textContent = location.host;
  $('admin-details').innerHTML = [['运行环境', `${runtime.platform} · ${runtime.nodeVersion}`], ['服务版本', runtime.revision], ['内存使用', bytes(runtime.memoryBytes)], ['连续运行', `${Math.floor(runtime.uptimeSeconds / 60)} 分钟`]].map(([key, value]) => `<div><span>${escape(key)}</span><strong>${escape(value)}</strong></div>`).join('');
  const workbench = $('open-workbench');
  try { const url = new URL(report.appUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error(); workbench.href = url.href; workbench.hidden = false; }
  catch { workbench.hidden = true; }
  const labels = { login: '管理后台登录', setup: '初始化管理后台', api_settings_save: '保存 API 接口设置', api_connection_test: '检测模型目录', api_model_add: '添加模型', api_model_update: '更新模型', api_default_model: '设置默认模型', api_provider_delete: '删除模型连接', api_model_delete: '移除模型' };
  $('audit-table').innerHTML = audit.length ? audit.map(entry => `<tr><td>${date(entry.time)}</td><td>${escape(labels[entry.action] || entry.action)}</td><td>${escape(({ success: '成功', failed: '未完成' })[entry.result] || entry.result)}</td><td>${escape(entry.detail || '—')}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">暂无操作记录</td></tr>';
  $('last-refreshed').textContent = `更新于 ${date(report.updatedAt, true)}`;
}
async function refresh() {
  if (!authenticated || refreshPending) return;
  refreshPending = true; $('refresh').disabled = true;
  try { const next = await api('/api/overview'); if (!authenticated) return; report = next; render(); $('connection-error').hidden = true; }
  catch (error) { $('connection-error').hidden = false; $('connection-error').textContent = error.message; }
  finally { refreshPending = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', () => { refresh(); if (currentPage === 'api-settings') modelUI.load(); if (currentPage === 'websites') websiteUI.load(); });
const modelUI = initApiSettings({ api, toast, escape, icon, date, number });
const websiteUI = initWebsites({ api, toast, escape, icon, date });
setInterval(() => { if (!document.hidden) { refresh(); if (currentPage === 'websites' && authenticated) websiteUI.refreshHosting(); } }, 8000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
try {
  const session = await api('/api/session'); csrf = session.csrf || ''; $('node-address').textContent = location.host;
  if (session.authenticated) await enter(); else showAuth(session.setupRequired);
} catch (error) { $('auth-title').textContent = '暂时无法连接管理服务'; $('auth-description').textContent = `${error.message} 请刷新页面重试。`; }
