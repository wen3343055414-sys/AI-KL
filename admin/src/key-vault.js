import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readSecret } from '../../src/config.js';
import { HttpError } from './store.js';

// The envelope and an independently stored key can move between operating systems.
// Never generate a replacement key when an existing key is missing.
export class KeyVault {
  constructor({ key = process.env.SECRET_ENCRYPTION_KEY, keyFile = process.env.SECRET_ENCRYPTION_KEY_FILE } = {}) {
    this.key = key;
    this.keyFile = keyFile;
  }
  async encryptionKey() {
    try { return Buffer.from(await readSecret(this.key, this.keyFile, 'SECRET_ENCRYPTION_KEY'), 'hex'); }
    catch { throw new HttpError(503, '服务端加密密钥未配置或无法读取，配置未修改。'); }
  }
  async protect(value) {
    const key = await this.encryptionKey();
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from('zhizuotai:model-key:v1'));
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
    } finally { key.fill(0); }
  }
  async unprotect(value) {
    if (typeof value !== 'string' || !/^v1:[A-Za-z0-9+/]{16}:[A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]*={0,2}$/.test(value))
      throw new HttpError(503, '已保存密钥的格式不受支持，请在服务端重新输入该连接的密钥。');
    const key = await this.encryptionKey();
    try {
      const [, iv, tag, content] = value.split(':');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from('zhizuotai:model-key:v1'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(content, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new HttpError(503, '无法解密已保存的密钥，请检查服务端加密密钥或重新输入该连接的密钥。'); }
    finally { key.fill(0); }
  }
}
