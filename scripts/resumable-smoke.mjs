import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { createHash } from 'node:crypto';

const root = await mkdtemp(path.join(os.tmpdir(), 'xiazai-resumable-browser-'));
const artifacts = path.resolve('.verification'); await mkdir(artifacts, { recursive: true });
const runtime = await createApp({ dataDir: path.join(root, 'data'), adminPassword: 'browser-resume-password' });
const server = runtime.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const file = path.join(root, 'large-original.bin'), size = 101 * 1024 ** 2 + 17;
  const handle = await open(file, 'w'); await handle.truncate(size); await handle.write(Buffer.from('resumable final marker'), 0, 22, size - 22); await handle.close();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByText('大小、数量不限', { exact: false }).waitFor();
  let lostCreation=false;
  await page.route('**/api/uploads',async route=>{if(lostCreation)return route.continue();lostCreation=true;await route.fetch();await route.abort('connectionreset');});
  let sends = [], rejected = false, interrupted = false;
  let releaseFirst; const firstChunk = new Promise(resolve => releaseFirst = resolve);
  await page.route('**/api/uploads/*/files/*', async route => {
    const offset = Number(route.request().headers()['upload-offset']), body = route.request().postDataBuffer(); sends.push({ offset, size: body.length });
    if (sends.length === 1) await firstChunk;
    if (!rejected) { rejected = true; return route.fulfill({ status: 413, contentType: 'text/html', body: '<html>proxy upload too large</html>' }); }
    if (offset > 0 && !interrupted) { interrupted = true; return route.abort('connectionreset'); }
    await route.continue();
  });
  await page.locator('#file-input').setInputFiles(file);
  await page.getByText('链接已生成，文件上传中', { exact: true }).waitFor();
  const earlyShare = await page.getByLabel('文件分享链接').inputValue(); assert.ok(earlyShare.startsWith(base + '/s/'));
  await page.waitForFunction(url => document.querySelector('#copy-label').textContent === '已复制', earlyShare);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), earlyShare);
  assert.equal(runtime.store.transfers.size, 0);
  const receiver = await context.newPage(); await receiver.goto(earlyShare);
  await receiver.getByRole('heading', {name: '文件正在上传', exact: true}).waitFor();
  assert.equal(await receiver.getByRole('link', {name: '打包下载'}).count(), 0);
  await receiver.getByText('large-original.bin', {exact: true}).waitFor();
  const pending = await (await context.request.get(earlyShare.replace('/s/', '/api/transfers/'))).json();
  assert.equal(pending.uploadedSize, 0); assert.equal(pending.uploading, true);
  await page.screenshot({path: path.join(artifacts, 'early-share-upload.png'), fullPage: true});
  releaseFirst();
  await page.waitForFunction(() => document.querySelector('#progress-percent').textContent !== '0%');
  await page.getByRole('button', { name: '暂停上传', exact: true }).click();
  await page.getByText('上传已暂停，进度已保留', { exact: true }).waitFor();
  const receipt = await page.evaluate(() => JSON.parse(localStorage.getItem('xiazai-resumable-v1'))[0]); assert.ok(receipt.id && receipt.token);
  for (let i = 0; i < 100 && runtime.activeUploads; i++) await new Promise(r => setTimeout(r, 10));
  const status = await (await context.request.get(`${base}/api/uploads/${receipt.id}`, { headers: { Authorization: `Upload ${receipt.token}` } })).json();
  assert.ok(status.files[0].offset > 0); const confirmed = status.files[0].offset;
  await page.reload(); await page.getByText('有未完成上传，重新选择相同文件可断点续传', { exact: true }).waitFor();
  const before = sends.length;
  await page.locator('#file-input').setInputFiles(file);
  await page.getByText('文件准备好了', { exact: true }).waitFor({ timeout: 90000 });
  assert.ok(sends[before].offset >= confirmed); assert.ok(sends.every(s => s.size <= 4 * 1024 ** 2));
  assert.ok(rejected && interrupted && lostCreation); assert.equal(runtime.store.transfers.size, 1);assert.equal(runtime.uploads.sessions.size,1);
  const share = await page.getByLabel('文件分享链接').inputValue(), transfer = await (await context.request.get(share.replace('/s/', '/api/transfers/'))).json();
  assert.equal(share, earlyShare); assert.equal(transfer.totalSize, size); assert.equal(transfer.files[0].name, 'large-original.bin');
  await receiver.getByRole('link', {name: '打包下载'}).waitFor();
  assert.equal(await receiver.getByRole('heading', {name: '文件正在上传', exact: true}).count(), 0);
  await receiver.close();
  const persisted = await readFile(path.join(root, 'data', 'uploads', transfer.id, transfer.files[0].id)), source = await readFile(file);
  assert.equal(createHash('sha256').update(persisted).digest('hex'), createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('xiazai-resumable-v1'))), []);
  // Response loss after final commit must be retried without creating a second transfer.
  await page.getByRole('button', { name: '继续发送', exact: true }).click();
  const small = path.join(root, 'small.txt'), fs = await import('node:fs/promises'); await fs.writeFile(small, 'lost complete response');
  let lost = false;
  await page.route('**/api/uploads/*/complete', async route => {
    if (lost) return route.continue(); lost = true; await route.fetch(); await route.abort('connectionreset');
  });
  await page.locator('#file-input').setInputFiles(small); await page.getByText('文件准备好了', { exact: true }).waitFor(); assert.equal(runtime.store.transfers.size, 2); await page.unroute('**/api/uploads/*/complete');
  await page.getByRole('button', { name: '继续发送', exact: true }).click();
  let blockChunk; const blocked = new Promise(r => blockChunk = r);
  await page.route('**/api/uploads/*/files/*', async route => { await blocked; try { await route.continue(); } catch {} });
  await page.locator('#file-input').setInputFiles(file); await page.waitForFunction(() => document.querySelector('#progress-title').textContent === '正在分块上传…');
  const cancelledShare = await page.getByLabel('文件分享链接').inputValue();
  await page.getByRole('button', { name: '取消上传', exact: true }).click(); blockChunk(); await page.getByText('上传已取消，未完成文件已清理', { exact: true }).waitFor();
  assert.equal((await context.request.get(cancelledShare.replace('/s/', '/api/transfers/'))).status(), 410);
  assert.equal(runtime.uploads.sessions.size, 2); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(artifacts, 'resumable-upload.png'), fullPage: true });
  console.log('Resumable browser smoke passed: early copied share link, receiver progress and automatic downloads, original names, >100 MB, proxy 413 chunk reduction, pause/reload resume, lost responses and cancel cleanup.');
} finally { await browser?.close(); runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); }
