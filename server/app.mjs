import express from 'express';
import { ZipArchive } from 'archiver';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { id, readJson, secretEqual, MiB, terminal, httpError } from './util.mjs';
import { Store } from './store.mjs';
import { parseUpload } from './upload.mjs';
import { getRelease, newer } from './releases.mjs';
import { Auth, publicUser } from './auth.mjs';
import { previewType, isText, textPreview, zipEntries, readZipEntry } from './preview.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export async function createApp({ dataDir, adminUsername = 'admin', adminPassword, publicUrl = '', updateKey, updaterUrl, clock = Date.now, releaseFetcher = getRelease, diskProbe } = {}) {
  const store = new Store(dataDir, clock, diskProbe); await store.init();
  const auth = new Auth(store.root, clock); await auth.init(adminUsername, adminPassword);
  const app = express(); app.disable('x-powered-by');
  let activeUploads = 0, closing = false, maintenance = false;
  const failures = new Map();
  const jobPath = path.join(store.root, 'system', 'update.json');
  const updateState = () => readJson(jobPath, { phase: 'idle', message: '尚未执行更新' });
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use((req, res, next) => {
    req.sessionToken = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('xiazai_session='))?.slice(15);
    req.user = auth.userFor(req.sessionToken); next();
  });
  // State-changing requests must originate from this site. Proxy Host must be preserved.
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      let host;
      try { host = new URL(req.headers.origin).host; } catch { return next(httpError(403, '请求来源无效')); }
      if (host !== req.get('host')) return next(httpError(403, '请求来源不允许'));
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const requireUser = (req, res, next) => req.user ? next() : next(httpError(401, '请先登录'));
  app.use('/api/admin', (req, res, next) => {
    if (!req.user) return next(httpError(401, '请先登录管理员账号'));
    if (req.user.role !== 'admin') return next(httpError(403, '仅管理员可以操作系统设置和升级'));
    next();
  });
  const cookie = (req, res, value, clear = false) => {
    const secure = req.secure || (publicUrl || store.settings.publicUrl).startsWith('https://');
    res.cookie('xiazai_session', value, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: clear ? 0 : 7 * 86400000 });
  };
  const authRate = (req, res, next) => {
    const key = req.socket.remoteAddress, now = clock();
    const previous = failures.get(key), attempt = previous && previous.until > now ? previous : { count: 0, until: now + 600000 };
    if (attempt.count >= 30) return next(httpError(429, '请求过于频繁，请 10 分钟后再试'));
    attempt.count++; failures.set(key, attempt);
    if (failures.size > 10000) for (const [k, v] of failures) if (v.until < now) failures.delete(k);
    next();
  };
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
  app.post('/api/auth/register', authRate, async (req, res) => {
    await auth.register(req.body.username, req.body.password);
    const result = await auth.login(req.body.username, req.body.password);
    cookie(req, res, result.token); res.status(201).json({ user: result.user });
  });
  app.post('/api/auth/login', authRate, async (req, res) => {
    const result = await auth.login(req.body.username, req.body.password);
    cookie(req, res, result.token); res.json({ user: result.user });
  });
  app.post('/api/auth/logout', async (req, res) => { await auth.logout(req.sessionToken); cookie(req, res, '', true); res.json({ ok: true }); });
  app.put('/api/auth/password', requireUser, authRate, async (req, res) => {
    await auth.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    cookie(req, res, '', true); res.json({ ok: true });
  });
  app.get('/api/history', requireUser, (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1), pageSize = 20;
    const all = [...store.transfers.values()].filter(t => t.ownerId === req.user.id).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ transfers: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize });
  });
  app.delete('/api/history/:id', requireUser, async (req, res) => {
    const transfer = store.transfers.get(req.params.id);
    if (!transfer || transfer.ownerId !== req.user.id) throw httpError(404, '文件记录不存在');
    await store.deleteTransfer(transfer.id); res.json({ ok: true });
  });
  app.get('/api/health', (req, res) => res.json({ ok: !closing, version: pkg.version }));
  app.get('/api/config', (req, res) => res.json({ version: pkg.version, siteName: store.settings.siteName,
    retentionHours: store.settings.retentionHours, diskStopPercent: 95,
    publicUrl: publicUrl || store.settings.publicUrl }));
  app.post('/api/upload', async (req, res) => {
    const state = await updateState();
    if (closing || maintenance || !terminal.has(state.phase)) throw httpError(503, '系统正在更新，请稍后上传');
    if (activeUploads >= 5) throw httpError(429, '当前上传人数较多，请稍后重试');
    const hours = req.query.hours === undefined ? store.settings.retentionHours : Number(req.query.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > store.settings.retentionHours) throw httpError(400, '保留时间超出允许范围');
    const transferId = id(), folder = path.join(store.stagingDir, transferId);
    activeUploads++;
    try {
      await store.disk.check();
      await mkdir(folder);
      const files = await parseUpload(req, res, folder, store.disk);
      if (req.aborted || res.destroyed) throw httpError(400, '上传已取消');
      await store.disk.check();
      const createdAt = clock();
      const transfer = { id: transferId, ownerId: req.user?.id || null, files, totalSize: files.reduce((n, f) => n + f.size, 0),
        createdAt, expiresAt: createdAt + hours * 3600000 };
      await store.commit(folder, transfer);
      const { ownerId, ...shared } = transfer;
      res.status(201).json({ ...shared, sharePath: `/s/${transferId}` });
    } finally {
      activeUploads--;
      await rm(folder, { recursive: true, force: true });
    }
  });
  const transferFor = req => {
    const transfer = store.get(req.params.id);
    if (!transfer) throw httpError(410, '链接已失效，文件可能已过期或不存在');
    return transfer;
  };
  app.get('/api/transfers/:id', (req, res) => { const { ownerId, ...shared } = transferFor(req); res.json(shared); });
  const previewFile = req => {
    const transfer = transferFor(req), file = transfer.files.find(f => f.id === req.params.fileId);
    if (!file) throw httpError(404, '文件不存在');
    return { transfer, file, filename: store.filePath(transfer.id, file.id) };
  };
  const inlineHeaders = (res, type) => res.set({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox" });
  app.get('/api/transfers/:id/files/:fileId/preview', async (req, res, next) => {
    const { transfer, file, filename } = previewFile(req), release = store.acquire(transfer);
    res.on('close', release); res.on('finish', release);
    if (isText(file.name)) { res.json({ type: 'text', text: await textPreview(filename, file.name) }); return; }
    const type = previewType(file.name);
    if (!type) throw httpError(415, '此文件格式暂不支持在线预览，请下载查看');
    inlineHeaders(res, type);
    res.sendFile(filename, error => { release(); if (error && !res.headersSent) next(error); else if (error) res.destroy(); });
  });
  let zipReaders = 0;
  const zipLimit = (req, res, next) => {
    if (zipReaders >= 2) return next(httpError(429, '当前解压任务较多，请稍后再试'));
    zipReaders++; let released = false;
    const release = () => { if (!released) { released = true; zipReaders--; } };
    res.on('close', release); res.on('finish', release); next();
  };
  app.get('/api/transfers/:id/files/:fileId/entries', zipLimit, async (req, res) => {
    const { transfer, file, filename } = previewFile(req);
    if (!file.name.toLowerCase().endsWith('.zip')) throw httpError(415, '只支持 ZIP 压缩包');
    const release = store.acquire(transfer);
    try { res.json({ entries: await zipEntries(filename) }); } finally { release(); }
  });
  app.get('/api/transfers/:id/files/:fileId/entries/:index', zipLimit, async (req, res) => {
    const { transfer, file, filename } = previewFile(req);
    if (!file.name.toLowerCase().endsWith('.zip')) throw httpError(415, '只支持 ZIP 压缩包');
    const release = store.acquire(transfer);
    try {
      const entry = await readZipEntry(filename, Number(req.params.index));
      if (req.query.preview === '1') {
        if (isText(entry.name)) {
          if (entry.data.length > 2 * MiB) throw httpError(413, '文本超过 2 MB，请下载查看');
          return res.json({ type: 'text', text: entry.data.toString('utf8') });
        }
        const type = previewType(entry.name);
        if (!type) throw httpError(415, '此格式暂不支持预览，请下载查看');
        inlineHeaders(res, type); res.send(entry.data);
      } else res.attachment(entry.name).set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }).send(entry.data);
    } finally { release(); }
  });
  app.get('/api/transfers/:id/files/:fileId', async (req, res, next) => {
    const transfer = transferFor(req), file = transfer.files.find(f => f.id === req.params.fileId);
    if (!file) throw httpError(404, '文件不存在');
    const release = store.acquire(transfer);
    res.on('close', release); res.on('finish', release);
    res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream' });
    res.download(store.filePath(transfer.id, file.id), file.name, { dotfiles: 'deny' }, error => {
      release(); if (error && !res.headersSent) next(error); else if (error) res.destroy();
    });
  });
  app.get('/api/transfers/:id/zip', async (req, res) => {
    const transfer = transferFor(req), release = store.acquire(transfer);
    const archive = new ZipArchive({ zlib: { level: 0 } });
    res.attachment(`xiazai-${transfer.id.slice(0, 8)}.zip`).set('Cache-Control', 'no-store');
    res.on('close', () => { archive.abort(); release(); }); res.on('finish', release);
    archive.on('error', error => res.destroy(error));
    archive.on('warning', error => res.destroy(error));
    archive.pipe(res);
    const names = new Set();
    for (const file of transfer.files) {
      let name = file.name, count = 1;
      while (names.has(name)) { count++; name = `${path.parse(file.name).name} (${count})${path.extname(file.name)}`; }
      names.add(name); archive.file(store.filePath(transfer.id, file.id), { name });
    }
    await archive.finalize();
  });
  app.get('/api/admin/settings', async (req, res) => res.json({ settings: store.settings, stats: await store.stats(),
    version: pkg.version, updateEnabled: Boolean(updaterUrl && updateKey), update: await updateState() }));
  app.put('/api/admin/settings', async (req, res) => res.json({ settings: await store.saveSettings(req.body), stats: await store.stats() }));
  app.post('/api/admin/cleanup', async (req, res) => res.json({ ...await store.cleanup(), stats: await store.stats() }));
  app.get('/api/admin/storage', async (req, res) => res.json({ stats: await store.stats() }));
  app.get('/api/admin/update', async (req, res) => res.json(await updateState()));
  app.get('/api/admin/version', async (req, res) => {
    const release = await releaseFetcher();
    res.json({ current: pkg.version, latest: release.version, available: newer(release.version, pkg.version),
      notes: release.notes, publishedAt: release.publishedAt, url: release.url });
  });
  app.post('/api/admin/update', async (req, res) => {
    if (!updaterUrl || !updateKey) throw httpError(503, '在线升级需要使用配套 Docker Compose 部署');
    if (activeUploads) throw httpError(409, '仍有文件正在上传，请上传完成后再更新');
    maintenance = true;
    try {
      const release = await releaseFetcher();
      if (!newer(release.version, pkg.version)) throw httpError(409, '当前已是最新版本');
      const response = await fetch(`${updaterUrl}/update`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${updateKey}` },
        body: JSON.stringify({ version: release.version }), signal: AbortSignal.timeout(60000) });
      const result = await response.json();
      if (!response.ok) throw httpError(response.status, result.error || '无法启动更新');
      res.status(202).json(result);
    } finally { maintenance = false; }
  });
  app.use(express.static(publicDir, { index: false, maxAge: 0 }));
  app.get(['/', '/s/:id'], (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use((req, res) => res.status(404).json({ error: '页面不存在' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return res.destroy();
    const status = error.status || (error.code === 'ENOSPC' ? 507 : 500);
    if (status >= 500 && status !== 503 && status !== 507) console.error(error.message);
    res.status(status).json({ error: status === 500 ? '服务器处理失败，请稍后重试' : error.message });
  });
  const scheduler = setInterval(() => {
    if (clock() >= store.system.lastCleanupAt + store.settings.cleanupIntervalHours * 3600000) store.cleanup().catch(e => console.error('清理失败:', e.message));
  }, 60000); scheduler.unref();
  return { app, store, auth, version: pkg.version, close: () => { closing = true; clearInterval(scheduler); }, get activeUploads() { return activeUploads; } };
}
