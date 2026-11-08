import { statfs } from 'node:fs/promises';
import { httpError } from './util.mjs';

export const DISK_STOP_PERCENT = 95;
const fullDisk = () => httpError(507, '服务器磁盘使用率已达到 95%，已停止上传。请清理磁盘空间后重试。');

// statfs on the data bind mount measures the host filesystem, including files outside this app.
export class DiskGuard {
  constructor(root, probe = statfs) {
    this.root = root; this.probe = probe; this.queue = Promise.resolve();
    this.uploads = new Set(); this.timer = null; this.polling = false;
  }
  async sample() {
    let fs;
    try { fs = await this.probe(this.root, { bigint: true }); }
    catch { throw httpError(503, '无法读取服务器磁盘空间，已暂停上传，请稍后重试'); }
    const blockSize = BigInt(fs.bsize), total = BigInt(fs.blocks) * blockSize;
    const free = BigInt(fs.bfree) * blockSize, available = BigInt(fs.bavail) * blockSize;
    if (blockSize <= 0n || total <= 0n || free < 0n || free > total || available < 0n || available > free) throw httpError(503, '无法读取服务器磁盘空间，已暂停上传，请稍后重试');
    const used = total - free;
    return { blockSize, total, free, available, used };
  }
  async info() {
    const disk = await this.sample();
    return { totalBytes: Number(disk.total), usedBytes: Number(disk.used), freeBytes: Number(disk.free),
      availableBytes: Number(disk.available), usedPercent: Number(disk.used * 10000n / disk.total) / 100,
      stopPercent: DISK_STOP_PERCENT, uploadAllowed: disk.used * 100n < disk.total * 95n && disk.available > 0n,
      checkedAt: Date.now() };
  }
  async check(bytes = 0) {
    const disk = await this.sample();
    const blocks = (BigInt(bytes) + disk.blockSize - 1n) / disk.blockSize;
    const needed = blocks * disk.blockSize;
    if ((disk.used + needed) * 100n >= disk.total * 95n || needed > disk.available || disk.available === 0n) {
      const error = fullDisk(); this.stopUploads(error); throw error;
    }
  }
  // Serialize checks AND writes across all uploads, including files in one multipart request.
  // Each write finishes before the next check; no cached free-space estimate or buffered reservations.
  write(bytes, action, signal) {
    const task = this.queue.then(async () => {
      signal?.throwIfAborted();
      await this.check(bytes);
      signal?.throwIfAborted();
      await action();
    });
    this.queue = task.catch(() => {}); return task;
  }
  watch(controller) {
    this.uploads.add(controller);
    if (!this.timer) {
      this.timer = setInterval(async () => {
        if (this.polling) return;
        this.polling = true;
        try { await this.check(); }
        catch (error) { this.stopUploads(error); }
        finally { this.polling = false; }
      }, 1000);
      this.timer.unref();
    }
    return () => {
      this.uploads.delete(controller);
      if (!this.uploads.size) { clearInterval(this.timer); this.timer = null; }
    };
  }
  stopUploads(error) { for (const controller of this.uploads) controller.abort(error); }
}
