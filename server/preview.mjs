import yauzl from 'yauzl';
import { stat, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { httpError, MiB } from './util.mjs';

const openZip = promisify(yauzl.open);
export const previewType = name => {
  const ext = path.extname(name).toLowerCase();
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.pdf': 'application/pdf' })[ext] || null;
};
const textExtensions = new Set(['.txt', '.md', '.json', '.csv', '.log', '.xml', '.yml', '.yaml', '.js', '.ts', '.py', '.css', '.html', '.ini', '.conf', '.sh', '.sql', '.toml', '.srt']);
export const isText = name => textExtensions.has(path.extname(name).toLowerCase());
export async function textPreview(filename, name) {
  if (!isText(name)) throw httpError(415, '此格式暂不支持文本预览，请下载查看');
  if ((await stat(filename)).size > 2 * MiB) throw httpError(413, '文本超过 2 MB，请下载查看');
  return (await readFile(filename)).toString('utf8');
}
function validateEntry(entry) {
  if (entry.generalPurposeBitFlag & 1) throw httpError(415, '加密 ZIP 暂不支持在线查看');
  const name = entry.fileName;
  if (name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || /[\x00-\x1f]/.test(name)) throw httpError(400, 'ZIP 包含不安全路径');
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > 100 * MiB) throw httpError(413, 'ZIP 内单个文件最大支持 100 MB');
  if (entry.uncompressedSize > MiB && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 200) throw httpError(413, 'ZIP 压缩率过高，无法在线解压');
}
export async function zipEntries(filename) {
  const zip = await openZip(filename, { lazyEntries: true, autoClose: true, validateEntrySizes: true }).catch(() => { throw httpError(400, 'ZIP 文件损坏或不支持'); });
  return new Promise((resolve, reject) => {
    const entries = []; let total = 0, settled = false;
    const fail = error => { if (!settled) { settled = true; zip.close(); reject(error.status ? error : httpError(400, 'ZIP 文件损坏或不支持')); } };
    zip.on('error', fail);
    zip.on('entry', entry => {
      try {
        validateEntry(entry); total += entry.uncompressedSize;
        if (entries.length >= 2000 || total > 500 * MiB) throw httpError(413, 'ZIP 目录超过 2000 项或解压总大小超过 500 MB');
        entries.push({ index: entries.length, name: entry.fileName, size: entry.uncompressedSize, directory: entry.fileName.endsWith('/') });
        zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.on('end', () => { if (!settled) { settled = true; resolve(entries); } }); zip.readEntry();
  });
}
export async function readZipEntry(filename, index) {
  if (!Number.isInteger(index) || index < 0 || index >= 2000) throw httpError(400, 'ZIP 文件索引无效');
  // Validate the entire archive before returning any entry.
  const listing = await zipEntries(filename), selected = listing[index];
  if (!selected || selected.directory) throw httpError(404, 'ZIP 内文件不存在');
  const zip = await openZip(filename, { lazyEntries: true, autoClose: false, validateEntrySizes: true });
  return new Promise((resolve, reject) => {
    let cursor = 0, settled = false;
    const fail = error => { if (!settled) { settled = true; zip.close(); reject(error.status ? error : httpError(400, 'ZIP 解压失败')); } };
    zip.on('error', fail);
    zip.on('entry', entry => {
      if (cursor++ !== index) { zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error) return fail(error);
        const chunks = []; let size = 0;
        stream.on('data', chunk => {
          size += chunk.length;
          if (size > selected.size || size > 100 * MiB) stream.destroy(httpError(413, 'ZIP 解压大小超过限制')); else chunks.push(chunk);
        });
        stream.on('error', fail);
        stream.on('end', () => {
          if (size !== selected.size) return fail(httpError(400, 'ZIP 文件大小校验失败'));
          if (!settled) { settled = true; zip.close(); resolve({ name: selected.name.split('/').pop(), data: Buffer.concat(chunks) }); }
        });
      });
    });
    zip.on('end', () => fail(httpError(404, 'ZIP 内文件不存在'))); zip.readEntry();
  });
}
