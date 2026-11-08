import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { safeName, id, atomicJson } from '../server/util.mjs';
import { Auth } from '../server/auth.mjs';
import { githubJson } from '../server/releases.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xiazai-audit-'));
  const runtime = await createApp({ dataDir: root, adminPassword: 'audit-admin-password', ...options });
  const server = runtime.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options) => fetch(base + url, options);
  const json = (url, body, cookie, method = 'POST') => request(url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const response = await json('/api/auth/login', { username: 'admin', password: 'audit-admin-password' });
  const cookie = response.headers.get('set-cookie').split(';')[0];
  t.after(async () => { runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, base, request, json, cookie };
}

test('missing or malformed auth bodies produce validation errors instead of server errors', async t => {
  const f = await fixture(t);
  for (const route of ['/api/auth/login', '/api/auth/register']) {
    assert.equal((await f.request(route, { method: 'POST' })).status, 400);
    assert.equal((await f.json(route, null)).status, 400);
    assert.equal((await f.json(route, [])).status, 400);
  }
  const invalid = await f.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"sensitive-example"' });
  assert.equal(invalid.status, 400); assert.ok(!(await invalid.text()).includes('sensitive-example'));
});

test('unauthenticated or unknown session logout does not rewrite account storage', async t => {
  const f = await fixture(t), file = path.join(f.root, 'accounts.json'), before = await stat(file);
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await f.request('/api/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  await f.request('/api/auth/logout', { method: 'POST', headers: { Cookie: 'xiazai_session=unknown' } });
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
});

test('history page is an integer and falls back to last page after deletions', async t => {
  const f = await fixture(t), admin = f.runtime.auth.findByName('admin');
  const transfer = { id: id(), ownerId: admin.id, files: [{ id: id(), name: 'history.txt', size: 0 }], totalSize: 0, createdAt: Date.now(), expiresAt: Date.now() + 3600000 };
  f.runtime.store.transfers.set(transfer.id, transfer);
  for (const page of ['2', '999999', 'Infinity', '1.5', '-3']) {
    const value = await (await f.request(`/api/history?page=${page}`, { headers: { Cookie: f.cookie } })).json();
    assert.equal(value.page, 1); assert.equal(value.transfers.length, 1);
  }
});

test('duplicate update checks are rejected while an update is being prepared', async t => {
  let releaseReady; const pending = [];
  const f = await fixture(t, { updaterUrl: 'http://127.0.0.1:1', updateKey: 'example-update-key-with-enough-length', releaseFetcher: () => new Promise(r => { releaseReady = r; pending.push(r); }) });
  const first = f.json('/api/admin/update', {}, f.cookie);
  while (!releaseReady) await new Promise(r => setTimeout(r, 5));
  const second = f.json('/api/admin/update', {}, f.cookie);
  const result = await Promise.race([second, new Promise(r => setTimeout(() => r(null), 150))]);
  // Always settle the first request so teardown does not hang on a regression.
  for (const resolve of pending) resolve({ version: '0.0.1' });
  assert.ok(result, 'duplicate request must not start another release lookup');
  assert.equal(result.status, 409); assert.equal((await first).status, 409);
});

test('deleting transfer is hidden before disk removal starts', async t => {
  const f = await fixture(t), transfer = { id: id(), files: [], totalSize: 0, createdAt: Date.now(), expiresAt: Date.now() + 3600000 };
  await mkdir(path.join(f.runtime.store.uploadsDir, transfer.id)); f.runtime.store.transfers.set(transfer.id, transfer);
  const deletion = f.runtime.store.deleteTransfer(transfer.id);
  await Promise.resolve();
  assert.equal(f.runtime.store.get(transfer.id), null);
  assert.throws(() => f.runtime.store.acquire(transfer), { status: 410 });
  await deletion;
});

test('Unicode and special filenames retain readable names without dot directory names', () => {
  assert.equal(safeName('€file.txt'), '€file.txt');
  assert.equal(safeName('中文文档.txt'), '中文文档.txt');
  assert.equal(safeName('..'), 'unnamed'); assert.equal(safeName('.'), 'unnamed');
  assert.ok(!safeName('😀'.repeat(200)).match(/[\uD800-\uDBFF]$/));
});

test('transient version service errors retry, network failure returns actionable gateway error', async () => {
  let requests = 0;
  const value = await githubJson('https://api.github.com/example', async () => {
    requests++; return requests < 2 ? { ok: false, status: 504 } : { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  assert.deepEqual(value, { ok: true }); assert.equal(requests, 2);
  await assert.rejects(githubJson('https://api.github.com/example', async () => { throw new Error('network down'); }), { status: 502 });
});

test('HTTP admin login works when share URL is configured for HTTPS', async t => {
  const f = await fixture(t, { publicUrl: 'https://files.example.com' });
  const response = await f.json('/api/auth/login', { username: 'admin', password: 'audit-admin-password' });
  assert.ok(!response.headers.get('set-cookie').includes('Secure'));
  const forwarded = await f.request('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https'},body:JSON.stringify({username:'admin',password:'audit-admin-password'})});
  assert.ok(forwarded.headers.get('set-cookie').includes('Secure'));
});

test('downloads and media preview support HEAD, byte ranges and unknown-file validation', async t => {
  const f = await fixture(t), body = new FormData(); body.append('files',new Blob(['0123456789']),'video.mp4');
  const upload = await f.request('/api/upload',{method:'POST',body});const transfer=await upload.json();
  const url=`/api/transfers/${transfer.id}/files/${transfer.files[0].id}`;
  for (const suffix of ['', '/preview']) {
    const head=await f.request(url+suffix,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
    const ranged=await f.request(url+suffix,{headers:{Range:'bytes=3-6'}});assert.equal(ranged.status,206);assert.equal(await ranged.text(),'3456');assert.equal(ranged.headers.get('content-range'),'bytes 3-6/10');
    const invalid=await f.request(url+suffix,{headers:{Range:'bytes=100-200'}});assert.equal(invalid.status,416);await invalid.text();
  }
  assert.equal(f.runtime.store.readers.size,0);
});

test('interrupted uploads release all handles and staging data', async t => {
  const f = await fixture(t); const http=await import('node:http');
  const request=http.request(`${f.base}/api/upload`,{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=cancel-test'}});request.on('error',()=>{});
  request.write('--cancel-test\r\nContent-Disposition: form-data; name="files"; filename="cancel.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');request.write(Buffer.alloc(256*1024));
  for(let i=0;i<50&&!f.runtime.activeUploads;i++)await new Promise(r=>setTimeout(r,10));
  request.destroy();
  for(let i=0;i<100&&f.runtime.activeUploads;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.runtime.activeUploads,0);assert.equal(f.runtime.store.disk.uploads.size,0);assert.deepEqual(await(await import('node:fs/promises')).readdir(f.runtime.store.stagingDir),[]);
});

test('concurrent password changes invalidate old sessions and reject the losing request', async t => {
  const f=await fixture(t), changes=await Promise.all([
    f.json('/api/auth/password',{currentPassword:'audit-admin-password',newPassword:'new-password-one'},f.cookie,'PUT'),
    f.json('/api/auth/password',{currentPassword:'audit-admin-password',newPassword:'new-password-two'},f.cookie,'PUT')
  ]);
  assert.equal(changes.filter(r=>r.status===200).length,1);assert.equal(changes.filter(r=>r.status===409).length,1);
  assert.equal((await(await f.request('/api/auth/me',{headers:{Cookie:f.cookie}})).json()).user,null);
});

test('empty account requests and oversized JSON never leak request bodies', async t => {
  const f=await fixture(t);
  const response=await f.request('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'test',password:'secret'.repeat(6000)})});
  assert.equal(response.status,413);assert.equal((await response.json()).error,'请求内容过大');
  assert.equal((await f.request('/api/auth/password',{method:'PUT',headers:{Cookie:f.cookie}})).status,400);
  assert.equal((await f.request('/api/admin/settings',{method:'PUT',headers:{Cookie:f.cookie}})).status,400);
});

test('unsafe ZIP paths and high compression archives are rejected without extraction', async t => {
  const f=await fixture(t);const {ZipWriter,Uint8ArrayWriter,TextReader}=await import('@zip.js/zip.js');
  for(const [name,content,level] of [['../escape.txt','unsafe path',0],['compressed.txt','0'.repeat(2*1024**2),9]]){
    const writer=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false});await writer.add(name,new TextReader(content),{level});
    const form=new FormData();form.append('files',new Blob([await writer.close()]),'unsafe.zip');
    const transfer=await(await f.request('/api/upload',{method:'POST',body:form})).json();
    const response=await f.request(`/api/transfers/${transfer.id}/files/${transfer.files[0].id}/entries`);assert.equal(response.status,name.includes('..')?400:413);await response.json();
  }
  assert.equal(f.runtime.store.readers.size,0);
});
