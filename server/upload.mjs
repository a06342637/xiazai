import { open, rm } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import multer from 'multer';
import { id, safeName, httpError } from './util.mjs';

export async function parseUpload(req, res, folder, disk) {
  const controller = new AbortController(), { signal } = controller;
  const unwatch = disk.watch(controller);
  const aborted = () => controller.abort(httpError(400, '上传已取消'));
  req.once('aborted', aborted);
  const jobs = new Set();
  let rejectAbort;
  const abortResult = new Promise((resolve, reject) => { rejectAbort = reject; });
  const stopReceiving = () => {
    req.unpipe(); req.pause();
    if (!res.headersSent) res.set('Connection', 'close');
    rejectAbort(signal.reason);
  };
  signal.addEventListener('abort', stopReceiving, { once: true });
  let failure;
  const storage = {
    _handleFile(request, file, callback) {
      const fileId = id(), filename = path.join(folder, fileId);
      let size = 0, handle;
      const writeFile = async () => {
        signal.throwIfAborted();
        handle = await open(filename, 'wx', 0o600);
        const output = new Writable({ write(chunk, encoding, done) {
          disk.write(chunk.length, async () => {
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
              if (!bytesWritten) throw httpError(507, '磁盘写入失败，已停止上传');
              offset += bytesWritten;
            }
            size += chunk.length;
          }, signal).then(() => done(), done);
        } });
        await pipeline(file.stream, output, { signal });
      };
      const job = writeFile().then(async () => {
        await handle.close(); callback(null, { id: fileId, path: filename, size, name: safeName(file.originalname) });
      }).catch(async error => {
        failure ||= signal.reason || error;
        controller.abort(failure);
        // Wait for queued writes before closing or removing incomplete files (also needed on Windows).
        await disk.queue;
        await handle?.close().catch(() => {});
        await rm(filename, { force: true }).catch(() => {});
        callback(failure);
      });
      jobs.add(job); job.finally(() => jobs.delete(job));
    },
    _removeFile(request, file, callback) { rm(file.path, { force: true }).then(() => callback(null), callback); }
  };
  const upload = multer({ storage, limits: { fields: 0, fieldNameSize: 100, headerPairs: 100 } }).array('files');
  const parsed = new Promise((resolve, reject) => upload(req, res, error => {
    if (error) {
      if (error instanceof multer.MulterError) return reject(httpError(400, '上传表单格式错误，请重新选择文件'));
      return reject(failure || signal.reason || error);
    }
    if (!req.files?.length) return reject(httpError(400, '请至少选择一个文件'));
    resolve(req.files.map(f => ({ id: f.id, name: f.name, size: f.size })));
  }));
  try { return await Promise.race([parsed, abortResult]); }
  finally {
    await Promise.allSettled([...jobs]);
    unwatch(); req.off('aborted', aborted); signal.removeEventListener('abort', stopReceiving);
  }
}
