import yauzl from 'yauzl';
import { stat, readFile, open } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { httpError, MiB } from './util.mjs';
import { Reader, ZipReader } from '@zip.js/zip.js';

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
        entries.push({ index: entries.length, name: entry.fileName, size: entry.uncompressedSize, directory: entry.fileName.endsWith('/'), encrypted: Boolean(entry.generalPurposeBitFlag & 1) });
        zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.on('end', () => { if (!settled) { settled = true; resolve(entries); } }); zip.readEntry();
  });
}
class FileReader extends Reader {
  constructor(handle, size) { super(); this.handle = handle; this.size = size; }
  async readUint8Array(index, length) {
    const buffer = Buffer.alloc(Math.min(length, Math.max(0, this.size - index)));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await this.handle.read(buffer, offset, buffer.length - offset, index + offset);
      if (!bytesRead) throw httpError(400, 'ZIP 文件已损坏或被截断');
      offset += bytesRead;
    }
    return buffer;
  }
}
async function withZip(filename, action) {
  const handle = await open(filename, 'r');
  const reader = new ZipReader(new FileReader(handle, (await handle.stat()).size), { useWebWorkers: false });
  try { return await action(reader); }
  finally { await reader.close(); await handle.close(); }
}
async function readEntry(entry, expectedSize, password, collect, signal) {
  if (entry.encrypted && !password) throw httpError(423, '此 ZIP 已加密，请输入解压密码');
  const chunks = []; let size = 0;
  const output = new WritableStream({ write(chunk) {
    size += chunk.length;
    if (size > expectedSize || size > 100 * MiB) throw httpError(413, 'ZIP 解压大小超过限制');
    if (collect) chunks.push(Buffer.from(chunk));
  } });
  try {
    await entry.getData(output, { password, checkCrc32: true, checkAuthenticationCode: true, useWebWorkers: false, signal });
    if (size !== expectedSize) throw httpError(400, 'ZIP 文件大小校验失败');
  } catch (error) {
    if (error.status) throw error;
    if (signal.aborted) throw httpError(408, 'ZIP 解压超时，请下载到本地查看');
    if (entry.encrypted) throw httpError(422, '解压密码不正确或加密文件已损坏，请重新输入');
    throw httpError(400, 'ZIP 文件损坏或此压缩格式不支持');
  }
  return collect ? Buffer.concat(chunks) : undefined;
}
export async function unlockZip(filename, password) {
  if (typeof password !== 'string' || !password || password.length > 256) throw httpError(400, '请输入 1～256 个字符的解压密码');
  const listing = await zipEntries(filename);
  // Validate actual decrypted content and checksums, including legacy ZipCrypto's weak password header.
  const signal = AbortSignal.timeout(30000);
  await withZip(filename, async reader => {
    let index = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      const metadata = listing[index++];
      if (!metadata || entry.filename !== metadata.name) throw httpError(400, 'ZIP 目录校验失败');
      if (metadata.encrypted && !metadata.directory) await readEntry(entry, metadata.size, password, false, signal);
    }
  });
  return listing;
}
export async function readZipEntry(filename, index, password) {
  if (!Number.isInteger(index) || index < 0 || index >= 2000) throw httpError(400, 'ZIP 文件索引无效');
  // Validate the entire archive before returning any entry.
  const listing = await zipEntries(filename), selected = listing[index];
  if (!selected || selected.directory) throw httpError(404, 'ZIP 内文件不存在');
  return withZip(filename, async reader => {
    let cursor = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (cursor++ !== index) continue;
      if (entry.filename !== selected.name) throw httpError(400, 'ZIP 目录校验失败');
      return { name: selected.name.split('/').pop(), data: await readEntry(entry, selected.size, password, true, AbortSignal.timeout(30000)) };
    }
    throw httpError(404, 'ZIP 内文件不存在');
  });
}
