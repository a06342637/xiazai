import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { CHUNK_BYTES } from '../server/resumable.mjs';
import { id } from '../server/util.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xiazai-resume-test-')); let now = Date.now();
  let runtime, server;
  async function start() {
    runtime = await createApp({ dataDir: root, adminPassword: 'resumable-admin-password', clock: () => now, ...options });
    server = runtime.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  }
  async function stop() { runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await start();
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const request = (url, opts = {}) => fetch(base() + url, opts);
  const create = async (files, hours = 24, cookie) => {
    const r = await request('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ files, hours }) });
    assert.equal(r.status, 201); return r.json();
  };
  const headers = (s, cookie) => ({ Authorization: `Upload ${s.token}`, ...(cookie ? { Cookie: cookie } : {}) });
  const put = (s, index, bytes, offset, cookie, checksum) => request(`/api/uploads/${s.id}/files/${s.files[index].id}`, { method: 'PUT', headers: { ...headers(s, cookie), 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset), ...(checksum ? { 'Upload-Checksum': checksum } : {}) }, body: bytes });
  return { root, base, request, create, headers, put, runtime: () => runtime, restart: async () => { await stop(); await start(); }, advance: n => now += n };
}

test('share links exist before bytes arrive, survive restart and unlock only after completion', async t => {
  const f = await fixture(t), names = ['项目文件夹.ZIP', 'Ã©.txt', 'Ã©.txt'];
  const upload = await f.create(names.map(name => ({name, size: 6})), 1);
  assert.equal(upload.sharePath, `/s/${upload.id}`); assert.equal(upload.transfer.uploading, true);
  const publicStatus = async () => {
    const response = await f.request(`/api/transfers/${upload.id}`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const shared = await response.json();
    for (const key of ['ownerId', 'secretHash', 'token', 'hours']) assert.equal(shared[key], undefined);
    return shared;
  };
  assert.equal((await f.request(upload.sharePath)).status, 200);
  assert.equal((await publicStatus()).uploadedSize, 0);
  const fileUrl = `/api/transfers/${upload.id}/files/${upload.files[0].id}`;
  for (const url of [fileUrl, `${fileUrl}/preview`, `/api/transfers/${upload.id}/zip`]) {
    const response = await f.request(url); assert.equal(response.status, 409); assert.match((await response.json()).error, /仍在上传/);
  }
  assert.equal((await f.put(upload, 0, Buffer.from('abc'), 0)).status, 200);
  assert.equal((await publicStatus()).uploadedSize, 3);
  await f.restart(); assert.equal((await publicStatus()).uploadedSize, 3);
  f.advance(3600001); // Retention starts when the upload completes, even for slow uploads.
  assert.equal((await f.put(upload, 0, Buffer.from('def'), 3)).status, 200);
  for (const index of [1, 2]) assert.equal((await f.put(upload, index, Buffer.from('abcdef'), 0)).status, 200);
  assert.equal((await f.request(fileUrl)).status, 409);
  const response = await f.request(`/api/uploads/${upload.id}/complete`, {method: 'POST', headers: f.headers(upload)});
  assert.equal(response.status, 200); const {transfer} = await response.json();
  assert.equal(transfer.sharePath, upload.sharePath); assert.equal(transfer.expiresAt - transfer.createdAt, 3600000);
  assert.deepEqual(transfer.files.map(file => file.name), names); assert.equal((await publicStatus()).uploading, undefined);
  const download = await f.request(fileUrl); assert.equal(download.status, 200); assert.equal(await download.text(), 'abcdef');
  assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent(names[0])));
});

test('files larger than 100 MB use bounded chunks and exactly match downloaded bytes', async t => {
  const f = await fixture(t), size = 101 * 1024 ** 2 + 137, upload = await f.create([{ name: 'large.bin', size }]);
  const chunk = Buffer.alloc(CHUNK_BYTES, 7), sourceHash = createHash('sha256');
  for (let offset = 0; offset < size;) {
    const part = chunk.subarray(0, Math.min(CHUNK_BYTES, size - offset)); sourceHash.update(part);
    const r = await f.put(upload, 0, part, offset, undefined, createHash('sha256').update(part).digest('hex')); assert.equal(r.status, 200); offset = (await r.json()).offset;
  }
  const completed = await f.request(`/api/uploads/${upload.id}/complete`, { method: 'POST', headers: f.headers(upload) }); assert.equal(completed.status, 200);
  const { transfer } = await completed.json(); assert.equal(transfer.totalSize, size);
  const download = await f.request(`/api/transfers/${transfer.id}/files/${transfer.files[0].id}`); const downloadedHash = createHash('sha256');
  for await (const part of download.body) downloadedHash.update(part);
  assert.equal(downloadedHash.digest('hex'), sourceHash.digest('hex'));
  const again = await f.request(`/api/uploads/${upload.id}/complete`, { method: 'POST', headers: f.headers(upload) }); assert.equal((await again.json()).transfer.id, transfer.id);
});

test('confirmed offsets survive restart; corrupt checksums and partial chunks rollback', async t => {
  const f = await fixture(t), upload = await f.create([{ name: 'resume.txt', size: 12 }]);
  assert.equal((await f.put(upload, 0, Buffer.from('hello '), 0)).status, 200);
  const invalid = await f.put(upload, 0, Buffer.from('world!'), 6, undefined, '0'.repeat(64)); assert.equal(invalid.status, 422);
  const filename = path.join(f.root, '.resumable', upload.id, upload.files[0].id); assert.equal((await stat(filename)).size, 6);
  // Simulate bytes written before a crash but not committed to the offset receipt.
  await writeFile(filename, 'hello UNCONFIRMED'); await f.restart(); assert.equal((await stat(filename)).size, 6);
  const status = await f.request(`/api/uploads/${upload.id}`, { headers: f.headers(upload) }); assert.equal((await status.json()).files[0].offset, 6);
  assert.equal((await f.put(upload, 0, Buffer.from('world!'), 0)).status, 409);
  assert.equal((await f.put(upload, 0, Buffer.from('world!'), 6)).status, 200);
  const completed = await f.request(`/api/uploads/${upload.id}/complete`, { method: 'POST', headers: f.headers(upload) }); const { transfer } = await completed.json();
  assert.equal(await readFile(path.join(f.root, 'uploads', transfer.id, transfer.files[0].id), 'utf8'), 'hello world!');
  await f.restart(); assert.equal((await (await f.request(`/api/uploads/${upload.id}`, { headers: f.headers(upload) })).json()).complete, true);
});

test('interrupted streaming chunk preserves earlier confirmed progress', async t => {
  const f = await fixture(t), upload = await f.create([{ name: 'interrupted.bin', size: 1000000 }]);
  assert.equal((await f.put(upload, 0, Buffer.from('done'), 0)).status, 200);
  const req = http.request(`${f.base()}/api/uploads/${upload.id}/files/${upload.files[0].id}`, { method: 'PUT', headers: { ...f.headers(upload), 'Content-Type': 'application/octet-stream', 'Upload-Offset': '4', 'Content-Length': '500000' } });
  req.on('error', () => {}); req.write(Buffer.alloc(10000));
  await new Promise(r => setTimeout(r, 40)); req.destroy();
  for (let n = 0; n < 100 && f.runtime().activeUploads; n++) await new Promise(r => setTimeout(r, 10));
  const status = await (await f.request(`/api/uploads/${upload.id}`, { headers: f.headers(upload) })).json(); assert.equal(status.files[0].offset, 4);
  assert.equal((await stat(path.join(f.root, '.resumable', upload.id, upload.files[0].id))).size, 4); assert.equal(f.runtime().uploads.busy.size, 0);
});

test('scoped tokens, limits, zero-byte files, cancellation and expiry are enforced', async t => {
  const f = await fixture(t), upload = await f.create([{ name: 'empty.txt', size: 0 }, { name: 'small.txt', size: 5 }], 'permanent');
  assert.equal((await f.request(`/api/uploads/${upload.id}`)).status, 404);
  assert.equal((await f.request(`/api/uploads/${upload.id}`, { headers: { Authorization: 'Upload ' + 'x'.repeat(48) } })).status, 404);
  assert.equal((await f.request(`/api/uploads/${upload.id}/complete`, { method: 'POST', headers: f.headers(upload) })).status, 409);
  assert.equal((await f.put(upload, 1, Buffer.from('too big'), 0)).status, 413);
  assert.equal((await f.put(upload, 1, Buffer.from('hello'), 0)).status, 200);
  const completed = await f.request(`/api/uploads/${upload.id}/complete`, { method: 'POST', headers: f.headers(upload) }); const { transfer } = await completed.json(); assert.equal(transfer.permanent, true); assert.equal(transfer.files[0].size, 0);
  const cancelled = await f.create([{ name: 'cancel.bin', size: 8 }]); await f.put(cancelled, 0, Buffer.from('part'), 0);
  assert.equal((await f.request(`/api/uploads/${cancelled.id}`, { method: 'DELETE', headers: f.headers(cancelled) })).status, 200);
  assert.equal((await f.request(`/api/uploads/${cancelled.id}`, { headers: f.headers(cancelled) })).status, 404);
  assert.equal((await f.request(`/api/transfers/${cancelled.id}`)).status, 410);
  const expired = await f.create([{ name: 'expire.bin', size: 8 }]); f.advance(86400001); await f.runtime().uploads.cleanup();
  assert.ok(!(await readdir(path.join(f.root, '.resumable'))).includes(expired.id));
  assert.equal((await f.request(`/api/transfers/${expired.id}`)).status, 410);
});

test('95% disk protection deletes incomplete resumable upload without removing previous shares', async t => {
  let free = 50000;
  const f = await fixture(t, { diskProbe: async () => ({ bsize: 4096, blocks: 100000, bfree: free, bavail: free }) });
  const upload = await f.create([{ name: 'disk.bin', size: 16 }]); await f.put(upload, 0, Buffer.from('first'), 0); free = 5000;
  const blocked = await f.put(upload, 0, Buffer.from('second'), 5); assert.equal(blocked.status, 507);
  assert.equal((await f.request(`/api/uploads/${upload.id}`, { headers: f.headers(upload) })).status, 404);
  assert.ok(!(await readdir(path.join(f.root, '.resumable'))).includes(upload.id));
});

test('logged-in upload sessions cannot be resumed by another account', async t => {
  const f = await fixture(t), login = await f.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'resumable-admin-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0], upload = await f.create([{ name: 'owned.txt', size: 5 }], 24, cookie);
  assert.equal((await f.request(`/api/uploads/${upload.id}`, { headers: f.headers(upload) })).status, 404);
  assert.equal((await f.put(upload, 0, Buffer.from('hello'), 0, cookie)).status, 200);
});

test('lost creation response can retry same request without orphan sessions or overwriting another upload',async t=>{
  const f=await fixture(t), payload={requestId:id(),token:id()+id(),hours:24,files:[{name:'retry.txt',size:5}]};
  const create=()=>f.request('/api/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const first=await create();assert.equal(first.status,201);const a=await first.json();const second=await create();assert.equal(second.status,201);assert.equal((await second.json()).id,a.id);assert.equal(f.runtime().uploads.sessions.size,1);
  payload.token=id()+id();assert.equal((await create()).status,404);assert.equal(f.runtime().uploads.sessions.size,1);
});
