import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { createApp } from '../server/app.mjs';
import { validateSettings } from '../server/store.mjs';
import { validId, GiB } from '../server/util.mjs';
import { zipEntries } from '../server/preview.mjs';
import { getRelease, newer } from '../server/releases.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(),'xiazai-test-'));
  let now = 1800000000000;
  const runtime = await createApp({dataDir:root,adminPassword:'isolated-admin-password',clock:() => now,
    releaseFetcher:async () => ({version:'1.1.0',notes:'A new release',url:'https://github.com/a06342637/xiazai/releases/tag/v1.1.0'})});
  const server = runtime.app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url,options={}) => fetch(base+url,options);
  const json = (url,body,method='POST',cookie) => request(url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const login = async (username='admin',password='isolated-admin-password') => {
    const response = await json('/api/auth/login',{username,password});
    assert.equal(response.status,200); return response.headers.get('set-cookie').split(';')[0];
  };
  const upload = async (entries=[['hello.txt','hello from xiazai']],cookie,query='') => {
    const body = new FormData(); entries.forEach(([name,content]) => body.append('files',new Blob([content]),name));
    return request(`/api/upload${query}`,{method:'POST',body,headers:cookie?{Cookie:cookie}:{}});
  };
  t.after(async () => { runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root,{recursive:true,force:true}); });
  return {root,runtime,base,request,json,login,upload,advance:delta => now+=delta};
}
async function archiveBuffer(entries) {
  const archive = new ZipArchive({zlib:{level:0}}), chunks=[];
  archive.on('data',chunk => chunks.push(chunk));
  const complete = new Promise((resolve,reject) => {archive.on('end',resolve);archive.on('error',reject);});
  for(const [name,content] of entries) archive.append(content,{name});
  await archive.finalize(); await complete; return Buffer.concat(chunks);
}

test('public upload, unicode filename, binary download, preview, ZIP bundle and anonymous metadata privacy',async t => {
  const f = await fixture(t), admin = await f.login();
  const response = await f.upload([['你好.txt','<script>not executable</script>'],['photo.png',Buffer.from([0,1,2,255])]],admin);
  assert.equal(response.status,201); const transfer = await response.json();
  assert.ok(validId(transfer.id)); assert.equal(transfer.files[0].name,'你好.txt'); assert.equal(transfer.ownerId,undefined);
  const shared = await (await f.request(`/api/transfers/${transfer.id}`)).json(); assert.equal(shared.ownerId,undefined);
  const download = await f.request(`/api/transfers/${transfer.id}/files/${transfer.files[0].id}`);
  assert.equal(await download.text(),'<script>not executable</script>'); assert.match(download.headers.get('content-disposition'),/attachment/);
  const text = await f.request(`/api/transfers/${transfer.id}/files/${transfer.files[0].id}/preview`);
  assert.equal((await text.json()).text,'<script>not executable</script>');
  const photo = await f.request(`/api/transfers/${transfer.id}/files/${transfer.files[1].id}/preview`);
  assert.equal(photo.headers.get('content-type'),'image/png'); assert.deepEqual(Buffer.from(await photo.arrayBuffer()),Buffer.from([0,1,2,255]));
  const archive = await f.request(`/api/transfers/${transfer.id}/zip`), zipPath = path.join(f.root,'bundle.zip');
  assert.equal(archive.status,200); await writeFile(zipPath,Buffer.from(await archive.arrayBuffer()));
  assert.deepEqual((await zipEntries(zipPath)).map(e=>e.name),['你好.txt','photo.png']);
  assert.equal((await f.request('/api/health')).status,200);
});

test('account roles, sessions, ownership, history deletion and password change',async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/admin/settings')).status,401);
  const registered = await f.json('/api/auth/register',{username:'visitor',password:'visitor-password',role:'admin'});
  assert.equal(registered.status,201); const account = await registered.json(); assert.equal(account.user.role,'guest');
  const guest = registered.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('/api/admin/settings',{headers:{Cookie:guest}})).status,403);
  assert.equal((await f.request('/api/admin/version',{headers:{Cookie:guest}})).status,403);
  assert.equal((await f.json('/api/admin/update',{},'POST',guest)).status,403);
  const transfer = await (await f.upload(undefined,guest)).json();
  const history = await (await f.request('/api/history',{headers:{Cookie:guest}})).json(); assert.equal(history.total,1);
  assert.equal((await f.request('/api/history')).status,401);
  const admin = await f.login();
  assert.equal((await f.request(`/api/history/${transfer.id}`,{method:'DELETE',headers:{Cookie:admin}})).status,404);
  assert.equal((await f.json('/api/auth/register',{username:'VISITOR',password:'another-password'})).status,409);
  assert.equal((await f.json('/api/auth/password',{currentPassword:'wrong',newPassword:'replacement-password'},'PUT',guest)).status,401);
  assert.equal((await f.json('/api/auth/password',{currentPassword:'visitor-password',newPassword:'replacement-password'},'PUT',guest)).status,200);
  assert.equal((await f.request('/api/auth/me',{headers:{Cookie:guest}})).status,200);
  assert.equal((await (await f.request('/api/auth/me',{headers:{Cookie:guest}})).json()).user,null);
  const fresh = await f.login('visitor','replacement-password');
  assert.equal((await f.request(`/api/history/${transfer.id}`,{method:'DELETE',headers:{Cookie:fresh}})).status,200);
  assert.equal((await f.request(`/api/transfers/${transfer.id}`)).status,410);
  assert.equal((await f.request(`/api/history`,{headers:{Cookie:fresh}})).status,200);
  assert.equal((await f.request(`/api/auth/logout`,{method:'POST',headers:{Cookie:fresh}})).status,200);
  assert.equal((await f.request('/api/history',{headers:{Cookie:fresh}})).status,401);
});

test('expiry denies reads before disk cleanup; settings persist and preserve old expiry; readers block removal',async t => {
  const f = await fixture(t), admin = await f.login();
  const transfer = await (await f.upload(undefined,admin,'?hours=1')).json();
  await f.json('/api/admin/settings',{retentionHours:6,cleanupIntervalHours:2},'PUT',admin);
  assert.equal(f.runtime.store.get(transfer.id).expiresAt,transfer.expiresAt);
  assert.equal(JSON.parse(await readFile(path.join(f.root,'settings.json'),'utf8')).retentionHours,6);
  const release = f.runtime.store.acquire(f.runtime.store.get(transfer.id)); f.advance(3600001);
  assert.equal((await f.request(`/api/transfers/${transfer.id}`)).status,410);
  assert.equal((await f.request(`/api/transfers/${transfer.id}/files/${transfer.files[0].id}`)).status,410);
  let cleanup = await (await f.json('/api/admin/cleanup',{},'POST',admin)).json(); assert.equal(cleanup.deletedTransfers,0);
  release(); cleanup = await (await f.json('/api/admin/cleanup',{},'POST',admin)).json(); assert.equal(cleanup.deletedTransfers,1);
  assert.deepEqual(await readdir(f.runtime.store.uploadsDir),[]); assert.equal(cleanup.stats.usedBytes,0);
});

test('upload limits, empty upload, source protection, storage reservation and safe path handling',async t => {
  const f = await fixture(t), admin = await f.login();
  await f.json('/api/admin/settings',{maxUploadMB:1,maxStorageGB:1},'PUT',admin);
  assert.equal((await f.upload([['large.bin',Buffer.alloc(1024**2+1)]])).status,413);
  assert.deepEqual(await readdir(f.runtime.store.stagingDir),[]);
  assert.equal((await f.upload([])).status,400);
  assert.equal((await f.upload(undefined,undefined,'?hours=25')).status,400);
  assert.equal((await f.json('/api/auth/login',{username:'admin',password:'isolated-admin-password'},'POST',null)).status,200);
  assert.equal((await f.request('/api/auth/login',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await f.request('/api/transfers/..%2F..%2Faccounts.json')).status,410);
  assert.equal((await f.request('/accounts.json')).status,404);
  f.runtime.store.usedBytes=GiB;
  assert.equal((await f.upload()).status,507); assert.equal(f.runtime.store.reservedBytes,0);
  assert.throws(()=>validateSettings({retentionHours:0})); assert.throws(()=>validateSettings({publicUrl:'javascript:alert(1)'}));
  assert.throws(()=>validateSettings({publicUrl:'https://user:password@example.com'})); assert.throws(()=>validateSettings({maxUploadMB:2048,maxStorageGB:1}));
});

test('ZIP directory, nested entry text preview, extraction and decompression limits',async t => {
  const f = await fixture(t), zip = await archiveBuffer([['docs/readme.txt','zip content'],['nested/hello.json','{"ok":true}']]);
  const transfer = await (await f.upload([['sample.zip',zip]])).json(), base = `/api/transfers/${transfer.id}/files/${transfer.files[0].id}`;
  const entries = await (await f.request(`${base}/entries`)).json(); assert.equal(entries.entries.length,2);
  assert.equal((await (await f.request(`${base}/entries/0?preview=1`)).json()).text,'zip content');
  assert.equal(await (await f.request(`${base}/entries/1`)).text(),'{"ok":true}');
  assert.equal((await f.request(`${base}/entries/-1`)).status,400);
  const bad = await (await f.upload([['bad.zip','not a zip']])).json();
  assert.equal((await f.request(`/api/transfers/${bad.id}/files/${bad.files[0].id}/entries`)).status,400);
});

test('release manifests accept only official immutable digests',async () => {
  const release = {tag_name:'v1.1.0',draft:false,prerelease:false,body:'new',assets:[{name:'release.json',browser_download_url:'https://github.com/a06342637/xiazai/releases/download/v1.1.0/release.json'}]};
  const manifest = {schema:1,version:'1.1.0',image:`ghcr.io/a06342637/xiazai@sha256:${'a'.repeat(64)}`};
  const fetcher = async url => ({ok:true,status:200,json:async()=>url.includes('api.github')?release:manifest});
  assert.equal((await getRelease('1.1.0',fetcher)).version,'1.1.0');
  manifest.image='malicious/image:latest'; await assert.rejects(getRelease('1.1.0',fetcher),/校验失败/);
  assert.ok(newer('1.10.0','1.2.9')); assert.ok(!newer('1.0.0','1.0.0'));
});
