import { mkdir, open, readdir, rm, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { id, validId, atomicJson, readJson, safeName, originalFiles, MiB, httpError, secretEqual } from './util.mjs';

export const CHUNK_BYTES = 4 * MiB;
export const UPLOAD_TTL = 24 * 3600000;
const tokenHash = token => createHash('sha256').update(token).digest('hex');

function receiveChunk(req, handle, offset, limit, disk, signal) {
  let size = 0, pending = Promise.resolve();
  const hash = createHash('sha256');
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); signal.removeEventListener('abort', aborted); };
    const fail = error => {
      if (settled) return; settled = true; cleanup(); req.pause();
      pending.then(() => reject(error), () => reject(error));
    };
    const aborted = () => fail(signal.reason || httpError(400, '分块连接中断，已保留之前确认的进度'));
    const data = chunk => {
      req.pause();
      if (size + chunk.length > limit) return fail(httpError(413, '分块超过允许大小，请减小分块后重试'));
      const position = offset + size; size += chunk.length; hash.update(chunk);
      pending = disk.write(chunk.length, async () => {
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(chunk, written, chunk.length - written, position + written);
          if (!result.bytesWritten) throw httpError(507, '磁盘写入失败');
          written += result.bytesWritten;
        }
      }, signal);
      pending.then(() => { if (!settled) req.resume(); }, fail);
    };
    const end = () => pending.then(() => { if (settled) return; settled = true; cleanup(); resolve({ size, digest: hash.digest('hex') }); }, fail);
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted); signal.addEventListener('abort', aborted, { once: true });
    if (req.aborted || signal.aborted) aborted(); else req.resume();
  });
}

export class ResumableUploads {
  constructor(store, clock = Date.now) { this.store = store; this.clock = clock; this.root = path.join(store.root, '.resumable'); this.sessions = new Map(); this.busy = new Set(); }
  folder(key) { if (!validId(key)) throw httpError(404, '上传任务不存在'); return path.join(this.root, key); }
  async save(session) { await atomicJson(path.join(this.folder(session.id), 'session.json'), session); }
  async init() {
    await mkdir(this.root, { recursive: true });
    for (const key of await readdir(this.root)) {
      if (!validId(key)) continue;
      const folder = this.folder(key);
      try {
        if (!(await lstat(folder)).isDirectory()) throw new Error('Invalid upload folder');
        const session = await readJson(path.join(folder, 'session.json'), null);
        if (!session || session.id !== key || !/^[a-f0-9]{64}$/.test(session.secretHash) || !Number.isSafeInteger(session.expiresAt) || !Array.isArray(session.files) || !session.files.length ||
          new Set(session.files.map(f => f.id)).size !== session.files.length || !session.files.every(f => validId(f.id) && typeof f.name === 'string' && Number.isSafeInteger(f.size) && f.size >= 0 && Number.isSafeInteger(f.offset) && f.offset >= 0 && f.offset <= f.size)) throw new Error('Invalid upload session');
        if (session.expiresAt <= this.clock()) { await rm(folder, { recursive: true, force: true }); continue; }
        const committed = this.store.transfers.get(key);
        if (committed) session.complete = true;
        if (!session.complete) for (const file of session.files) {
          const filename = path.join(folder, file.id), info = await lstat(filename).catch(e => { if (e.code === 'ENOENT' && file.offset === 0) return null; throw e; });
          if (info && (!info.isFile() || info.size < file.offset)) throw new Error('Upload file incomplete');
          if (info?.size > file.offset) { const handle = await open(filename, 'r+'); try { await handle.truncate(file.offset); await handle.sync(); } finally { await handle.close(); } }
        }
        this.sessions.set(key, session);
      } catch { console.error(`无法恢复分块上传 ${key}，原始数据保留待管理员检查`); }
    }
  }
  async create(input, user, retentionHours) {
    if (!input || !Array.isArray(input.files) || !input.files.length) throw httpError(400, '请至少选择一个文件');
    if (this.sessions.size >= 1000) throw httpError(429, '待完成上传较多，请稍后重试');
    const hours = input.hours === 'permanent' ? null : input.hours === undefined ? retentionHours : input.hours;
    if (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > retentionHours)) throw httpError(400, '保留时间超出允许范围');
    let total = 0;
    const files = input.files.map(file => {
      if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 1024 || !Number.isSafeInteger(file.size) || file.size < 0) throw httpError(400, '文件信息无效');
      total += file.size; if (!Number.isSafeInteger(total)) throw httpError(400, '文件总大小无效');
      return { id: id(), name: safeName(file.name, false), size: file.size, offset: 0 };
    });
    const key = input.requestId || id(), token = input.token || id() + id();
    if (!validId(key) || !/^[A-Za-z0-9_-]{48}$/.test(token)) throw httpError(400, '上传任务标识无效');
    if (this.sessions.has(key)) {
      const session = this.authorize(key, token, user);
      if (session.hours !== hours || session.files.length !== files.length || !session.files.every((f,index)=>f.name===files[index].name&&f.size===files[index].size)) throw httpError(409, '上传任务文件不匹配');
      return { ...this.status(session), token };
    }
    if (this.busy.has(key)) throw httpError(409, '上传任务正在创建，请稍后重试');
    this.busy.add(key); let created = false;
    try {
      await this.store.disk.check();
      const now = this.clock(), session = { id: key, secretHash: tokenHash(token), ownerId: user?.id || null, hours, createdAt: now, expiresAt: now + UPLOAD_TTL, files };
      await mkdir(this.folder(session.id)); created = true;
      await this.save(session); this.sessions.set(session.id, session);
      return { ...this.status(session), token };
    } catch(error) { if(created)await rm(this.folder(key),{recursive:true,force:true});throw error; }
    finally { this.busy.delete(key); }
  }
  authorize(key, token, user) {
    const session = validId(key) && this.sessions.get(key);
    if (!session || typeof token !== 'string' || token.length !== 48 || !secretEqual(tokenHash(token), session.secretHash) || session.ownerId && session.ownerId !== user?.id) throw httpError(404, '上传任务不存在或访问凭据无效');
    if (session.expiresAt <= this.clock()) throw httpError(410, '上传任务已过期，请重新上传');
    return session;
  }
  status(session) {
    const transfer = this.store.transfers.get(session.id);
    if (transfer) { const { ownerId, ...shared } = transfer; return { id: session.id, complete: true, transfer: { ...shared, sharePath: `/s/${session.id}` } }; }
    if (session.complete) throw httpError(410, '该次分享已被清理或删除');
    return { id: session.id, complete: false, sharePath: `/s/${session.id}`, transfer: this.pendingShare(session.id), chunkBytes: CHUNK_BYTES, expiresAt: session.expiresAt, files: session.files.map(f => ({ id: f.id, name: f.name, size: f.size, offset: f.offset })) };
  }
  pendingShare(key) {
    const session = validId(key) && this.sessions.get(key);
    if (!session || session.complete || session.expiresAt <= this.clock() || this.store.transfers.has(key)) return null;
    return { id: key, uploading: true, sharePath: `/s/${key}`, createdAt: session.createdAt, permanent: session.hours === null,
      expiresAt: session.expiresAt, totalSize: session.files.reduce((n, f) => n + f.size, 0), uploadedSize: session.files.reduce((n, f) => n + f.offset, 0),
      files: session.files.map(({ id, name, size }) => ({ id, name, size })) };
  }
  async mutate(session, action) {
    if(this.sessions.get(session.id)!==session)throw httpError(410,'上传任务已取消或过期');
    if (this.busy.has(session.id)) throw httpError(409, '该上传任务正在处理，请稍后重试');
    this.busy.add(session.id);
    try { return await action(); } finally { this.busy.delete(session.id); }
  }
  async chunk(session, fileId, req) {
    return this.mutate(session, async () => {
      if (session.complete || this.store.transfers.has(session.id)) throw httpError(409, '上传任务已完成');
      const file = session.files.find(f => f.id === fileId), offset = Number(req.headers['upload-offset']);
      if (!file) throw httpError(404, '上传文件不存在');
      if (!/^\d+$/.test(String(req.headers['upload-offset'])) || !Number.isSafeInteger(offset) || offset !== file.offset) throw httpError(409, '上传进度已变化，请读取服务器进度后继续');
      const limit = Math.min(CHUNK_BYTES, file.size - offset), declared = req.headers['content-length'];
      if (!limit || declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit || Number(declared) === 0)) throw httpError(413, '分块大小不正确');
      if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw httpError(415, '分块必须使用二进制格式');
      const expectedDigest = req.headers['upload-checksum'];
      if (expectedDigest && !/^[a-f0-9]{64}$/.test(expectedDigest)) throw httpError(400, '分块摘要格式错误');
      const controller = new AbortController(), unwatch = this.store.disk.watch(controller);
      let handle;
      try {
        await this.store.disk.check();
        const filename = path.join(this.folder(session.id), file.id);
        handle = await open(filename, 'r+').catch(error => { if (error.code === 'ENOENT' && offset === 0) return open(filename, 'wx+', 0o600); throw error; });
        await handle.truncate(offset);
        const result = await receiveChunk(req, handle, offset, limit, this.store.disk, controller.signal);
        if (!result.size || expectedDigest && expectedDigest !== result.digest) throw httpError(422, '分块校验失败，请重传当前分块');
        await handle.sync(); controller.signal.throwIfAborted();
        const next = { ...session, expiresAt: this.clock() + UPLOAD_TTL, files: session.files.map(f => f === file ? { ...f, offset: offset + result.size } : f) };
        await this.save(next); Object.assign(session, next);
        return { offset: offset + result.size, size: file.size };
      } catch (error) {
        if (handle) { await handle.truncate(offset).catch(() => {}); await handle.sync().catch(() => {}); }
        if (error.status === 507 || error.code === 'ENOSPC') {
          await handle?.close(); handle = null;
          await rm(this.folder(session.id), { recursive: true, force: true }); this.sessions.delete(session.id);
        }
        if (!req.readableEnded) { req.pause(); }
        throw error;
      } finally { unwatch(); await handle?.close(); }
    });
  }
  async complete(session) {
    return this.mutate(session, async () => {
      if (this.store.transfers.has(session.id) || session.complete) return this.status(session);
      if (session.files.some(f => f.offset !== f.size)) throw httpError(409, '文件尚未上传完整');
      await this.store.disk.check();
      for (const file of session.files) if (!file.size) { const handle = await open(path.join(this.folder(session.id), file.id), 'a', 0o600); await handle.close(); }
      const createdAt = this.clock(), files = originalFiles(session.files.map(({ offset, ...file }) => file));
      const transfer = { id: session.id, ownerId: session.ownerId, files, totalSize: files.reduce((n, f) => n + f.size, 0), createdAt, permanent: session.hours === null, expiresAt: session.hours === null ? 8640000000000000 : createdAt + session.hours * 3600000 };
      const folder = this.folder(session.id);
      await this.store.commit(folder, transfer);
      session.complete = true;
      // Retain a small completion receipt for retries after a lost response; no uploaded bytes are duplicated.
      await this.save(session).catch(error => console.error('分块完成回执写入失败:', error.message));
      return this.status(session);
    });
  }
  async cancel(session) { return this.mutate(session, async () => { await rm(this.folder(session.id), { recursive: true, force: true }); this.sessions.delete(session.id); return { ok: true }; }); }
  async cleanup() {
    for (const session of this.sessions.values()) if (!this.busy.has(session.id) && session.expiresAt <= this.clock()) await this.cancel(session);
  }
}
