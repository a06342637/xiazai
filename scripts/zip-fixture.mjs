import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from '@zip.js/zip.js';

export async function encryptedZip(entries, password = 'zip-test-password', zipCrypto = false) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { password, zipCrypto, useWebWorkers: false });
  for (const [name, content] of entries) await writer.add(name, new Uint8ArrayReader(Buffer.from(content)), { level: 0 });
  return Buffer.from(await writer.close());
}
