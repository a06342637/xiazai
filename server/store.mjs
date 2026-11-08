import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, readJson, validId, httpError } from './util.mjs';
import { DiskGuard } from './disk.mjs';

export const defaults = {
  siteName: '临时下载', retentionHours: 24, cleanupIntervalHours: 24,
  publicUrl: ''
};

export function validateSettings(input, previous = defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, '设置格式错误');
  const result = { ...previous };
  // Old persisted quotas must not restrict uploads after an online upgrade.
  delete result.maxUploadMB; delete result.maxStorageGB;
  for (const [key, minimum, maximum] of [
    ['retentionHours', 1, 8760], ['cleanupIntervalHours', 1, 168]
  ]) {
    if (input[key] !== undefined) {
      const value = input[key];
      if (!Number.isInteger(value) || value < minimum || value > maximum) throw httpError(400, `${key} 必须是 ${minimum}～${maximum} 的整数`);
      result[key] = value;
    }
  }
  if (input.siteName !== undefined) {
    if (typeof input.siteName !== 'string' || !input.siteName.trim() || input.siteName.trim().length > 30) throw httpError(400, '站点名称需为 1～30 个字符');
    result.siteName = input.siteName.trim();
  }
  if (input.publicUrl !== undefined) {
    if (typeof input.publicUrl !== 'string') throw httpError(400, '分享域名格式错误');
    const value = input.publicUrl.trim().replace(/\/+$/, '');
    if (value) {
      let url;
      try { url = new URL(value); } catch { throw httpError(400, '请输入完整的 http(s) 域名'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw httpError(400, '分享域名只能包含 http(s) 协议和域名');
    }
    result.publicUrl = value;
  }
  return result;
}

export class Store {
  constructor(root, clock = Date.now, diskProbe) {
    this.root = path.resolve(root); this.clock = clock; this.transfers = new Map();
    this.readers = new Map(); this.usedBytes = 0;
    this.disk = new DiskGuard(this.root, diskProbe);
    this.settingsQueue = Promise.resolve(); this.cleanupQueue = Promise.resolve();
  }
  get uploadsDir() { return path.join(this.root, 'uploads'); }
  get stagingDir() { return path.join(this.root, '.staging'); }
  async init() {
    await mkdir(this.uploadsDir, { recursive: true });
    await mkdir(this.stagingDir, { recursive: true });
    this.settings = validateSettings(await readJson(path.join(this.root, 'settings.json'), defaults));
    this.system = await readJson(path.join(this.root, 'system.json'), { lastCleanupAt: null });
    // Only unfinished uploads from a previous stopped process are removed at boot.
    for (const item of await readdir(this.stagingDir)) if (validId(item)) await rm(path.join(this.stagingDir, item), { recursive: true, force: true });
    for (const name of await readdir(this.uploadsDir)) {
      if (!validId(name)) continue;
      const folder = path.join(this.uploadsDir, name);
      const transfer = await readJson(path.join(folder, 'meta.json'), null);
      if (!transfer) { await rm(folder, { recursive: true, force: true }); continue; }
      if (transfer.id !== name || !Array.isArray(transfer.files) || !transfer.files.every(file => validId(file.id) && Number.isSafeInteger(file.size) && file.size >= 0)) throw new Error(`损坏的文件记录: ${name}`);
      transfer.totalSize = transfer.files.reduce((n, f) => n + f.size, 0);
      this.transfers.set(name, transfer); this.usedBytes += transfer.totalSize;
    }
    await this.cleanup();
  }
  get(id) {
    if (!validId(id)) return null;
    const transfer = this.transfers.get(id);
    return transfer && transfer.expiresAt > this.clock() ? transfer : null;
  }
  filePath(transferId, fileId) {
    if (!validId(transferId) || !validId(fileId)) throw httpError(404, '文件不存在');
    return path.join(this.uploadsDir, transferId, fileId);
  }
  acquire(transfer) {
    this.readers.set(transfer.id, (this.readers.get(transfer.id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const remaining = this.readers.get(transfer.id) - 1;
      if (remaining) this.readers.set(transfer.id, remaining); else this.readers.delete(transfer.id);
    };
  }
  async commit(folder, transfer) {
    await atomicJson(path.join(folder, 'meta.json'), transfer);
    await rename(folder, path.join(this.uploadsDir, transfer.id));
    this.transfers.set(transfer.id, transfer); this.usedBytes += transfer.totalSize;
  }
  saveSettings(input) {
    const task = this.settingsQueue.then(async () => {
      const next = validateSettings(input, this.settings);
      await atomicJson(path.join(this.root, 'settings.json'), next); this.settings = next;
      return next;
    });
    this.settingsQueue = task.catch(() => {}); return task;
  }
  cleanup() {
    const task = this.cleanupQueue.then(async () => {
      let deletedTransfers = 0, deletedBytes = 0;
      for (const [key, transfer] of this.transfers) {
        if (transfer.expiresAt > this.clock() || this.readers.has(key)) continue;
        await rm(path.join(this.uploadsDir, key), { recursive: true, force: true });
        this.transfers.delete(key); this.usedBytes -= transfer.totalSize;
        deletedTransfers++; deletedBytes += transfer.totalSize;
      }
      this.system.lastCleanupAt = this.clock();
      await atomicJson(path.join(this.root, 'system.json'), this.system);
      return { deletedTransfers, deletedBytes };
    });
    this.cleanupQueue = task.catch(() => {}); return task;
  }
  async deleteTransfer(key) {
    const task = this.cleanupQueue.then(async () => {
      const transfer = this.transfers.get(key);
      if (!transfer) throw httpError(404, '文件记录不存在');
      if (this.readers.has(key)) throw httpError(409, '有人正在下载或预览，请稍后删除');
      await rm(path.join(this.uploadsDir, key), { recursive: true, force: true });
      this.transfers.delete(key); this.usedBytes -= transfer.totalSize;
    });
    this.cleanupQueue = task.catch(() => {}); return task;
  }
  async stats() {
    const active = [...this.transfers.values()].filter(t => t.expiresAt > this.clock());
    return { usedBytes: this.usedBytes, disk: await this.disk.info(), totalTransfers: this.transfers.size,
      activeTransfers: active.length, expiredTransfers: this.transfers.size - active.length,
      lastCleanupAt: this.system.lastCleanupAt,
      nextCleanupAt: this.system.lastCleanupAt + this.settings.cleanupIntervalHours * 3600000 };
  }
}
