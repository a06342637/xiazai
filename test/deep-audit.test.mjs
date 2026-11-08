import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { WorkPool } from '../server/work-pool.mjs';
import { Store } from '../server/store.mjs';
import { Auth } from '../server/auth.mjs';
import { getRelease } from '../server/releases.mjs';
import { id, atomicJson } from '../server/util.mjs';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js';
import http from 'node:http';
import { zipEntries, readZipEntry } from '../server/preview.mjs';

const temporary = async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xiazai-deep-audit-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
};
async function app(t) {
  const root = await temporary(t), runtime = await createApp({ dataDir: root, adminPassword: 'deep-audit-password' });
  const server = runtime.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return { root, runtime, server, base: `http://127.0.0.1:${server.address().port}` };
}

test('password work bounds concurrency and waiting requests and always releases slots', async () => {
  const pool = new WorkPool(1, 1); let release, active = 0, peak = 0;
  const run = async action => { active++; peak = Math.max(peak, active); try { return await action(); } finally { active--; } };
  const first = pool.run(() => run(() => new Promise(r => { release = r; })));
  const next = pool.run(() => run(() => 'queued'));
  await assert.rejects(pool.run(() => assert.fail('must not run')), { status: 429 });
  release(); await first; assert.equal(await next, 'queued'); assert.equal(peak, 1);
  await assert.rejects(pool.run(() => { throw new Error('expected'); }), /expected/); assert.equal(pool.active, 0);
});

test('same host with wrong protocol and cross-site fetch requests cannot change state', async t => {
  const f = await app(t), url = new URL(f.base);
  const login = headers => fetch(f.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username: 'admin', password: 'deep-audit-password' }) });
  assert.equal((await login({ Origin: `https://${url.host}` })).status, 403);
  assert.equal((await login({ Origin: f.base, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await login({ Origin: f.base, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  for (const route of ['/api/auth/login/', '/API/AUTH/LOGIN']) assert.equal((await fetch(f.base + route, { method: 'POST' })).status, 400);
});

test('image repository punctuation cannot bypass manifest repository matching', async () => {
  const release = { tag_name: 'v1.0.1', assets: [{ name: 'release.json', browser_download_url: 'https://github.com/a06342637/xiazai/releases/download/v1.0.1/release.json' }] };
  const manifest = { schema: 1, version: '1.0.1', image: `ghcrXio/a06342637/xiazai@sha256:${'a'.repeat(64)}` };
  const fetcher = async url => ({ ok: true, status: 200, json: async () => url.includes('api.github.com') ? release : manifest });
  await assert.rejects(getRelease('1.0.1', fetcher), { status: 502 });
});

test('one corrupted or orphan share cannot stop healthy shares and is never deleted automatically', async t => {
  const root = await temporary(t), uploads = path.join(root, 'uploads'); await mkdir(uploads);
  const healthy = id(), bad = id(), orphan = id(), badDate = id(), missing = id();
  for (const key of [healthy, bad, orphan, badDate, missing]) await mkdir(path.join(uploads, key));
  const file = { id: id(), name: 'keep.txt', size: 4 };
  const meta = key => ({ id: key, files: [file], totalSize: 4, createdAt: Date.now(), expiresAt: Date.now() + 86400000 });
  await writeFile(path.join(uploads, healthy, file.id), 'safe'); await atomicJson(path.join(uploads, healthy, 'meta.json'), meta(healthy));
  await writeFile(path.join(uploads, bad, 'meta.json'), '{broken'); await writeFile(path.join(uploads, bad, 'original-file'), 'recover me');
  await writeFile(path.join(uploads, orphan, 'original-file'), 'orphan recover me');
  await atomicJson(path.join(uploads, badDate, 'meta.json'), { ...meta(badDate), expiresAt: 'bad date' });
  await atomicJson(path.join(uploads, missing, 'meta.json'), meta(missing));
  const store = new Store(root); await store.init();
  assert.ok(store.get(healthy)); assert.equal(store.recoveryIssues.length, 4); assert.equal(store.usedBytes, 4);
  assert.equal(await readFile(path.join(uploads, bad, 'original-file'), 'utf8'), 'recover me');
  assert.equal(await readFile(path.join(uploads, orphan, 'original-file'), 'utf8'), 'orphan recover me');
  assert.equal((await readdir(uploads)).length, 5);
});

test('invalid account database fails closed without changing credentials', async t => {
  const root = await temporary(t), accounts = path.join(root, 'accounts.json');
  const broken = JSON.stringify({ users: [{ id: id(), username: 'admin', role: 'admin', password: 'invalid' }], sessions: [] });
  await writeFile(accounts, broken);
  await assert.rejects(new Auth(root).init('admin', 'new-password'), /账号库无效/);
  assert.equal(await readFile(accounts, 'utf8'), broken);
});

test('oversized ZIP metadata and aborted entry extraction fail within online preview limits', async t => {
  const root = await temporary(t);
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add('a'.repeat(5000) + '.txt', new TextReader('x'), { level: 0 });
  const filename = path.join(root, 'long-name.zip'); await writeFile(filename, await writer.close());
  await assert.rejects(zipEntries(filename), { status: 413 });
  const regular = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false }); await regular.add('hello.txt', new TextReader('hello'), { level: 0 });
  const plain = path.join(root, 'plain.zip'); await writeFile(plain, await regular.close());
  await assert.rejects(readZipEntry(plain, 0, undefined, AbortSignal.abort()), { status: 408 });
});

test('bundle HEAD validates expiry without starting archiver or holding a reader', async t => {
  const f = await app(t), form = new FormData(); form.append('files', new Blob(['head archive']), 'head.txt');
  const transfer = await (await fetch(f.base + '/api/upload', { method: 'POST', body: form })).json();
  const head = await fetch(`${f.base}/api/transfers/${transfer.id}/zip`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(f.runtime.store.readers.size, 0);
  assert.equal((await fetch(`${f.base}/api/transfers/${id()}/zip`, { method: 'HEAD' })).status, 410);
});

test('slow decompressed downloads keep concurrency slots until their responses close', async t => {
  const f = await app(t), writer=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false});
  const held=[];
  // Deterministically stall response completion; loopback TCP can otherwise buffer an entire large response.
  f.server.prependListener('request',(req,res)=>{
    if(!req.url.endsWith('/entries/0'))return;
    const end=res.end;
    res.end=function(chunk,...args){if(this.statusCode!==200)return end.call(this,chunk,...args);this.write(chunk.subarray(0,1));held.push(()=>end.call(this,chunk.subarray(1),...args));return this;};
  });
  const {Uint8ArrayReader}=await import('@zip.js/zip.js');await writer.add('large.bin',new Uint8ArrayReader(Buffer.alloc(2*1024**2,7)),{level:0});
  const form=new FormData();form.append('files',new Blob([await writer.close()]),'slow.zip');
  const transfer=await(await fetch(f.base+'/api/upload',{method:'POST',body:form})).json(), url=`${f.base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`;
  const clients=[];
  const stalled=()=>new Promise((resolve,reject)=>{const client=http.get(url+'/entries/0',res=>{res.pause();clients.push({client,res});if(res.statusCode!==200)return reject(new Error(`decrypted download status ${res.statusCode}`));resolve();});client.on('error',reject);});
  try{await stalled();await stalled();const third=await fetch(url+'/entries');assert.equal(third.status,429);await third.text();}
  finally{for(const {client,res} of clients){res.destroy();client.destroy();}for(const end of held)end();}
  await new Promise(r=>setTimeout(r,50));assert.equal((await fetch(url+'/entries')).status,200);
});

test('many multipart files do not leave open handles or change requested file order', async t => {
  const f=await app(t), form=new FormData();for(let n=0;n<250;n++)form.append('files',new Blob(['x']),`order-${n}.txt`);
  const response=await fetch(f.base+'/api/upload',{method:'POST',body:form});assert.equal(response.status,201);const transfer=await response.json();
  for(let n=0;n<50&&f.runtime.activeUploads;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(transfer.files.length,250);assert.equal(transfer.files[249].name,'order-249.txt');assert.equal(f.runtime.activeUploads,0);assert.equal(f.runtime.store.disk.uploads.size,0);
});
