import { randomBytes, scrypt as scryptCallback, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { atomicJson, readJson, secretEqual, id, httpError } from './util.mjs';

const scrypt = promisify(scryptCallback);
const hashToken = value => createHash('sha256').update(value).digest('hex');
export const publicUser = user => user ? { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt } : null;
export function validateUsername(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{2,32}$/.test(value)) throw httpError(400, '用户名需为 2～32 位字母、数字、中文、下划线或短横线');
  return value;
}
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw httpError(400, '密码需为 8～128 个字符');
  return value;
}
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
export async function passwordMatches(password, encoded) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [salt, expected] = encoded.split(':');
  return secretEqual((await scrypt(password, salt, 64)).toString('hex'), expected);
}
export class Auth {
  constructor(root, clock = Date.now) { this.file = path.join(root, 'accounts.json'); this.clock = clock; this.queue = Promise.resolve(); }
  async init(username, password) {
    this.db = await readJson(this.file, { users: [], sessions: [] });
    if (!this.db.users.some(u => u.role === 'admin')) {
      validateUsername(username); validatePassword(password);
      this.db.users.push({ id: id(), username, role: 'admin', password: await passwordHash(password), createdAt: this.clock() });
      await atomicJson(this.file, this.db);
    }
  }
  mutate(action) {
    const task = this.queue.then(async () => {
      // Commit in-memory state only after durable write succeeds.
      const next = structuredClone(this.db), result = await action(next);
      next.sessions = next.sessions.filter(s => s.expiresAt > this.clock());
      await atomicJson(this.file, next); this.db = next;
      return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
  findByName(username) { return this.db.users.find(u => u.username.toLowerCase() === username.toLowerCase()); }
  async register(username, password) {
    validateUsername(username); validatePassword(password);
    const encoded = await passwordHash(password);
    return this.mutate(db => {
      if (db.users.length >= 10000) throw httpError(403, '注册用户数量已达上限');
      if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw httpError(409, '用户名已存在');
      const user = { id: id(), username, role: 'guest', password: encoded, createdAt: this.clock() };
      db.users.push(user); return publicUser(user);
    });
  }
  async login(username, password) {
    if (typeof username !== 'string') throw httpError(400, '请输入用户名和密码');
    const user = this.findByName(username);
    // Equal-cost dummy hash prevents a timing oracle for unknown users.
    if (!await passwordMatches(password, user?.password || `${'0'.repeat(32)}:${'0'.repeat(128)}`) || !user) throw httpError(401, '用户名或密码错误');
    const token = randomBytes(32).toString('base64url');
    await this.mutate(db => {
      if (!db.users.some(u => u.id === user.id && u.password === user.password)) throw httpError(401, '密码已变更，请重新登录');
      const own = db.sessions.filter(s => s.userId === user.id);
      if (own.length >= 10) db.sessions = db.sessions.filter(s => s.hash !== own[0].hash);
      db.sessions.push({ hash: hashToken(token), userId: user.id, expiresAt: this.clock() + 7 * 86400000 });
    });
    return { token, user: publicUser(user) };
  }
  userFor(token) {
    if (!token || token.length > 128) return null;
    const session = this.db.sessions.find(s => s.hash === hashToken(token) && s.expiresAt > this.clock());
    return session ? publicUser(this.db.users.find(u => u.id === session.userId)) : null;
  }
  logout(token) {
    if (!token || !this.db.sessions.some(s => s.hash === hashToken(token))) return Promise.resolve();
    return this.mutate(db => { db.sessions = db.sessions.filter(s => s.hash !== hashToken(token)); });
  }
  async changePassword(userId, current, replacement) {
    validatePassword(replacement);
    const user = this.db.users.find(u => u.id === userId);
    if (!user || !await passwordMatches(current, user.password)) throw httpError(401, '当前密码错误');
    const encoded = await passwordHash(replacement);
    return this.mutate(db => {
      const next = db.users.find(u => u.id === userId);
      if (next.password !== user.password) throw httpError(409, '密码已变更，请重新登录');
      next.password = encoded; db.sessions = db.sessions.filter(s => s.userId !== userId);
    });
  }
}
