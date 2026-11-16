import { readFile } from 'node:fs/promises';

export function serviceOrigin(value, name = '服务地址') {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name}必须是有效的 HTTP/HTTPS 地址。`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error(`${name}只接受 HTTP/HTTPS 来源，不能包含凭据、路径、查询或锚点。`);
  return url.origin;
}

export function listenOptions(host, port, name = '服务') {
  if (typeof host !== 'string' || !host.trim() || !/^\d+$/.test(String(port)) || Number(port) > 65535)
    throw new Error(`${name} HOST 不能为空；PORT 必须为 0–65535 的整数。`);
  return { host, port: Number(port) };
}

export async function readSecret(value, file, name) {
  const secret = file ? (await readFile(file, 'utf8')).trim() : value;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error(`${name}需要配置为 64 位十六进制随机值。`);
  return secret;
}
