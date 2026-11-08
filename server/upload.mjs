import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import multer from 'multer';
import { id, safeName, httpError } from './util.mjs';

export function parseUpload(req, res, folder, maxBytes) {
  let total = 0;
  const storage = {
    _handleFile(request, file, callback) {
      const fileId = id(), filename = path.join(folder, fileId);
      let size = 0;
      const limiter = new Transform({ transform(chunk, encoding, done) {
        total += chunk.length; size += chunk.length;
        done(total > maxBytes ? httpError(413, '文件总大小超过单次上传上限') : null, chunk);
      } });
      pipeline(file.stream, limiter, createWriteStream(filename, { flags: 'wx', mode: 0o600 }))
        .then(() => callback(null, { id: fileId, path: filename, size, name: safeName(file.originalname) }),
          error => rm(filename, { force: true }).then(() => callback(error), () => callback(error)));
    },
    _removeFile(request, file, callback) { rm(file.path, { force: true }).then(() => callback(null), callback); }
  };
  const upload = multer({ storage, limits: { files: 100, fields: 0, parts: 100, fileSize: maxBytes, fieldNameSize: 100, headerPairs: 100 } }).array('files', 100);
  return new Promise((resolve, reject) => upload(req, res, error => {
    if (error) {
      if (error instanceof multer.MulterError) return reject(httpError(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        error.code === 'LIMIT_FILE_SIZE' ? '文件超过上传上限' : '一次最多上传 100 个文件，请重新选择'));
      return reject(error);
    }
    if (!req.files?.length) return reject(httpError(400, '请至少选择一个文件'));
    resolve(req.files.map(f => ({ id: f.id, name: f.name, size: f.size })));
  }));
}
