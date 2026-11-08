import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const id = () => randomBytes(18).toString('base64url');
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{24}$/.test(value);
export const terminal = new Set(['idle', 'success', 'failed', 'rolled_back']);

export function secretEqual(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, filename);
}

export async function readJson(filename, fallback) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function safeName(name) {
  // Multipart filenames are commonly sent as UTF-8 interpreted as latin1.
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  const text = decoded.includes('\uFFFD') ? name : decoded;
  return text.replaceAll('\\', '/').split('/').pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || 'unnamed';
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
