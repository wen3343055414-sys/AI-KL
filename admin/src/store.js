import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const timestamp = () => new Date().toISOString();
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class AdminStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'admin.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, time TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, detail TEXT NOT NULL);
    `);
  }
  hasOwner() { return Boolean(this.db.prepare('SELECT 1 FROM owner WHERE id=1').get()); }
  async setup(password) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 128)
      throw new HttpError(400, '请设置 10–128 个字符的管理密码。');
    if (this.hasOwner()) throw new HttpError(409, '管理后台已初始化，请登录。');
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 })).toString('hex');
    if (!this.db.prepare('INSERT OR IGNORE INTO owner VALUES (1, ?, ?)').run(salt, hash).changes)
      throw new HttpError(409, '管理后台已初始化，请登录。');
    this.audit('setup', 'success', '已设置独立管理密码');
  }
  async checkPassword(password) {
    if (typeof password !== 'string' || password.length > 128) return false;
    const owner = this.db.prepare('SELECT salt, hash FROM owner WHERE id=1').get();
    if (!owner) return false;
    const candidate = await derive(password, owner.salt, 64, { N: 32768, maxmem: 64 * 1024 * 1024 });
    return timingSafeEqual(candidate, Buffer.from(owner.hash, 'hex'));
  }
  createSession() {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), csrf, Date.now() + 8 * 3600_000);
    return { token, csrf };
  }
  session(token) {
    if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
    return this.db.prepare('SELECT csrf FROM sessions WHERE hash=? AND expires>?').get(digest(token), Date.now()) || null;
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); }
  audit(action, result, detail = '') {
    this.db.prepare('INSERT INTO audit(time, action, result, detail) VALUES (?, ?, ?, ?)').run(timestamp(), action, result, String(detail).slice(0, 1500));
    this.db.exec('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 1000)');
  }
  audits() { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 40').all(); }
  close() { this.db.close(); }
}
