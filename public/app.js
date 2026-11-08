const $ = selector => document.querySelector(selector);
const icons = {
  send:'<path d="m4 10 16-6-6 16-4-6-6-4Z"/><path d="m10 14 10-10"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', close:'<path d="m6 6 12 12M18 6 6 18"/>',
  settings:'<path d="m9 3-.7 2.2-2.2 1L4 5.8 2.6 8.2l1.6 1.7-.2 2.4-1.8 1.5 1.2 2.5 2.3-.1 1.7 1.6.1 2.4 2.8.7 1.3-1.9 2.4-.2 1.6 1.6 2.5-1.4-.4-2.3 1.2-2 2.2-.7V11l-2.2-.7-1.2-2 .4-2.3-2.5-1.4-1.6 1.6-2.4-.2L12.8 3Z"/><circle cx="11.7" cy="11.7" r="3"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  moon:'<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
  user:'<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  history:'<path d="M3 11a9 9 0 1 1 2.2 7M3 4v7h7m2-4v5l3 2"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  link:'<path d="m10 13 4-4m-5 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2-2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
  check:'<path d="m5 12 5 5L20 7"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  file:'<path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 12h8m-8 4h5"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 8"/>',
  video:'<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 9 6-3v12l-6-3"/>',
  zip:'<path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M10 3v3m0 2v2m0 2v2"/><rect x="9" y="16" width="3" height="3" rx=".5"/>',
  folder:'<path d="M3 6h6l2 3h10v11H3V6Z"/>', trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`;
function decorate(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
const date = n => new Date(n).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const hoursText = n => n >= 24 && n % 24 === 0 ? `${n / 24} 天` : `${n} 小时`;
const permanentTransfer = transfer => transfer.permanent === true || transfer.expiresAt === null;
const expiryText = transfer => permanentTransfer(transfer) ? '永久保留' : `${date(transfer.expiresAt)} 到期失效`;
const activeTransfer = transfer => permanentTransfer(transfer) || transfer.expiresAt > Date.now();
let config = null, user = null, expiryHours = 24, request = null, toastTimer, authMode = 'login', authNext = null, page = 1, updatePoll = null, pendingDelete;
let currentZip = null, storagePoll = null;
const previewUrls = new Set();
function clearPreviewMedia() { for (const url of previewUrls) URL.revokeObjectURL(url); previewUrls.clear(); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers } });
  let value;
  try { value = await response.json(); } catch { throw new Error('服务暂时不可用，请稍后重试'); }
  if (!response.ok) { const error = new Error(value.error || '操作失败'); error.status = response.status; throw error; }
  return value;
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 4000); }
function showDialog(name) { const dialog = $(`#${name}`); if (!dialog.open) dialog.showModal(); }
function closeDialog(name) { $(`#${name}`).close(); }
function updateUser(next) { user = next; $('#account-label').textContent = user ? user.username : '登录 / 注册'; $('#panel-note').textContent = user ? '上传完成后自动复制链接，并保存到我的文件' : '上传完成后自动生成链接，并复制到剪贴板'; }
function applyConfig(next) {
  config = next; document.title = `${config.siteName} · 让文件轻松抵达`;
  document.querySelectorAll('.site-name').forEach(el => el.textContent = config.siteName);
  $('#footer-version').textContent = `v${config.version}`;
  $('#upload-limit').textContent = '大小、数量不限 · 磁盘使用率达到 95% 停止上传';
  expiryHours = Math.min(24, config.retentionHours);
  const choices = [...new Set([1, 6, 24, 72, 168].filter(n => n <= config.retentionHours).concat(config.retentionHours))].sort((a,b) => a-b);
  $('#expiry-options').innerHTML = choices.map(n => `<button class="expiry-button ${n === expiryHours ? 'active':''}" data-hours="${n}">${hoursText(n)}</button>`).join('') + '<button class="expiry-button" data-hours="permanent">永久</button>';
  $('#expiry-options').querySelectorAll('button').forEach(button => button.onclick = () => { expiryHours = button.dataset.hours === 'permanent' ? 'permanent' : Number(button.dataset.hours); $('#expiry-options .active')?.classList.remove('active'); button.classList.add('active'); $('.option-note').textContent = expiryHours === 'permanent' ? '保留至手动删除' : '到期自动失效'; });
}
function setTheme(theme) { document.documentElement.dataset.theme = theme; try { localStorage.setItem('xiazai-theme', theme); } catch {} $('#theme-button').innerHTML = icon(theme === 'dark' ? 'moon' : 'sun'); }
function resetUpload() { $('#dropzone').hidden = false; $('#upload-progress').hidden = true; $('#share-result').hidden = true; $('#upload-options').hidden = false; $('#file-input').value = ''; request = null; }
async function copy(text, automatic = false) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea'); field.value = text; field.className = 'clipboard-helper'; document.body.append(field); field.select();
      const done = document.execCommand('copy'); field.remove(); if (!done) throw new Error();
    }
    toast(automatic ? '上传成功，分享链接已复制' : '链接已复制'); return true;
  } catch { if (!automatic) toast('请长按或选中链接复制'); return false; }
}
function shareUrl(transfer) { return `${config.publicUrl || location.origin}/s/${transfer.id}`; }
function upload(files) {
  if (!config || request || !files.length) return;
  const total = [...files].reduce((n,f) => n + f.size, 0);
  $('#dropzone').hidden = true; $('#upload-progress').hidden = false; $('#upload-options').hidden = true;
  $('#progress-title').textContent = '正在上传…'; $('#progress-detail').textContent = `${files.length} 个文件 · ${bytes(total)} · 请保持页面打开`;
  $('#progress-fill').style.width = '0%'; $('#progress-percent').textContent = '0%';
  const form = new FormData(); [...files].forEach(file => form.append('files', file));
  request = new XMLHttpRequest(); const xhr = request;
  xhr.open('POST', `/api/upload?hours=${expiryHours}`); xhr.responseType = 'json';
  xhr.upload.onprogress = event => {
    if (!event.lengthComputable) return;
    const progress = Math.round(event.loaded / event.total * 100);
    $('#progress-fill').style.width = `${progress}%`; $('#progress-percent').textContent = `${progress}%`;
    if (progress === 100) $('#progress-title').textContent = '正在生成链接…';
  };
  xhr.onload = async () => {
    request = null;
    if (xhr.status !== 201) { resetUpload(); return toast(xhr.response?.error || '上传失败，请重试'); }
    const transfer = xhr.response, url = shareUrl(transfer);
    $('#upload-progress').hidden = true; $('#share-result').hidden = false;
    $('#share-url').value = url; $('#open-share').href = `/s/${transfer.id}`;
    $('#result-description').textContent = `${transfer.files.length} 个文件 · ${bytes(transfer.totalSize)}，现在就分享给对方吧。`;
    $('#result-expiry').textContent = permanentTransfer(transfer) ? '永久保留，分享链接持续有效' : `${date(transfer.expiresAt)} 到期，链接自动失效`;
    $('#result-file-list').innerHTML = transfer.files.map(file => fileRow(transfer, file)).join('');
    bindFiles($('#result-file-list'), transfer);
    const done = await copy(url, true); $('#copy-label').textContent = done ? '已复制' : '复制链接';
    if (!done) toast('上传成功，点击复制链接即可分享');
  };
  xhr.onerror = () => { resetUpload(); toast('网络连接中断，请重试'); };
  xhr.onabort = () => { resetUpload(); toast('上传已取消'); }; xhr.send(form);
}
function fileKind(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','avif'].includes(ext)) return 'image';
  if (['mp4','webm','mov'].includes(ext)) return 'video';
  if (['mp3','wav','ogg','m4a'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf'; if (ext === 'zip') return 'zip';
  if (['txt','md','json','csv','log','xml','yml','yaml','js','ts','py','css','html','ini','conf','sh','sql','toml','srt'].includes(ext)) return 'text';
  return 'file';
}
function fileRow(transfer, file) {
  const kind = fileKind(file.name);
  return `<div class="file-item"><div class="file-row"><span class="file-icon">${icon(kind)}</span><button class="file-info file-expand-button" data-expand="${file.id}" aria-label="展开 ${escape(file.name)}" aria-expanded="false"><span class="file-name">${escape(file.name)}</span><span class="file-size">${bytes(file.size)} · 点击展开</span></button><div class="file-actions">${kind !== 'file' ? `<button data-preview="${file.id}" aria-label="预览 ${escape(file.name)}" title="${kind === 'zip' ? '查看压缩包':'预览'}">${icon('eye')}</button>`:''}<a href="/api/transfers/${transfer.id}/files/${file.id}" aria-label="下载 ${escape(file.name)}" title="下载">${icon('download')}</a><button class="direct-link-button" data-direct="${file.id}" aria-label="复制 ${escape(file.name)} 下载直链" title="复制下载直链">直链</button></div></div><div class="inline-preview" hidden></div></div>`;
}
function bindFiles(panel, transfer) {
  panel.querySelectorAll('[data-preview]').forEach(button => button.onclick = () => preview(transfer, transfer.files.find(f => f.id === button.dataset.preview)));
  panel.querySelectorAll('[data-direct]').forEach(button => button.onclick = () => copy(`${config.publicUrl || location.origin}/api/transfers/${transfer.id}/files/${button.dataset.direct}`));
  panel.querySelectorAll('[data-expand]').forEach(button => button.onclick = async () => {
    const target = button.closest('.file-item').querySelector('.inline-preview'), file = transfer.files.find(f => f.id === button.dataset.expand);
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded)); target.hidden = !expanded;
    if (!expanded) {target.replaceChildren();return;}
    const kind = fileKind(file.name), url = `/api/transfers/${transfer.id}/files/${file.id}/preview`;
    if (['image','video','audio','pdf'].includes(kind)) {
      const media = document.createElement(kind === 'image' ? 'img' : kind === 'pdf' ? 'iframe' : kind);
      media.src = url; if(kind === 'image') media.alt = file.name; else if(kind === 'pdf') media.title = file.name; else {media.controls = true;media.preload = 'metadata';}
      media.onerror = () => {target.textContent = '当前浏览器无法预览此格式，请下载查看。';}; target.append(media);
    } else if (kind === 'text') {
      target.textContent = '正在加载预览…';
      try {const result = await api(url); if(target.hidden)return;const text = document.createElement('pre');text.textContent = result.text;target.replaceChildren(text);}catch(error){target.textContent = error.message;}
    } else if (kind === 'zip') {
      const open = document.createElement('button'); open.className = 'secondary-button'; open.textContent = '展开 ZIP 目录 / 输入解压密码'; open.onclick = () => preview(transfer, file);target.append(open);
    } else {target.textContent = `${file.name} · ${bytes(file.size)}。此格式请下载查看。`;}
  });
}
function setView(view) {
  document.body.dataset.view = view;
  $('#upload-panel').hidden = view !== 'upload'; $('#download-panel').hidden = view !== 'download'; $('#history-panel').hidden = view !== 'history';
  $('#features').hidden = view !== 'upload'; $('#quiet-note').hidden = view !== 'upload';
}
async function renderShare(id) {
  setView('download'); $('#hero h1').innerHTML = '文件已抵达，<span>请查收。</span>'; $('#hero>p').textContent = '先预览，再下载。无需登录，打开即用。';
  const panel = $('#download-panel'); panel.innerHTML = '<div class="empty-state"><p>正在获取文件…</p></div>';
  try {
    const transfer = await api(`/api/transfers/${encodeURIComponent(id)}`);
    panel.innerHTML = `<div class="download-head"><div><h2>你收到 ${transfer.files.length} 个文件</h2><p>总大小 ${bytes(transfer.totalSize)} · ${date(transfer.createdAt)} 分享</p></div><a class="primary-button" href="/api/transfers/${transfer.id}/zip">${icon('download')}打包下载</a></div><div class="file-list">${transfer.files.map(file => fileRow(transfer,file)).join('')}</div><div class="download-foot"><span>${icon('clock')}${expiryText(transfer)}</span><a href="/" class="text-button">我也要发送文件 →</a></div>`;
    bindFiles(panel, transfer);
  } catch (error) { panel.innerHTML = `<div class="empty-state"><div class="success-icon">${icon('clock')}</div><h2>这份分享已经离开了</h2><p>${escape(error.message)}<br>请联系发送者重新上传。</p><a class="primary-button" href="/">返回首页</a></div>`; }
}
async function renderMedia(name, url, back, headers) {
  const content = $('#preview-content'), kind = fileKind(name);
  $('#preview-title').textContent = name;
  clearPreviewMedia(); content.replaceChildren();
  if (back) { const button = document.createElement('button'); button.className = 'secondary-button zip-header'; button.textContent = '← 返回压缩包目录'; button.onclick = back; content.append(button); }
  const failed = () => { const notice = document.createElement('p'); notice.className = 'modal-description'; notice.textContent = '无法预览此文件，格式可能不受当前浏览器支持，请下载查看。'; content.append(notice); };
  if (kind === 'text') {
    try { const result = await api(url, { headers }); const pre = document.createElement('pre'); pre.textContent = result.text; content.append(pre); } catch(error) { if(error.status === 423 && currentZip) return renderZipPassword(error.message); const p = document.createElement('p'); p.textContent = error.message; content.append(p); }
  } else if (['image','video','audio'].includes(kind)) {
    if (headers) { try { url = await previewBlob(url, headers); } catch(error) { if(error.status === 423) return renderZipPassword(error.message); return failed(); } }
    const media = document.createElement(kind === 'image' ? 'img' : kind); media.src = url; media.onerror = failed;
    if (kind === 'image') media.alt = name; else { media.controls = true; media.preload = 'metadata'; }
    content.append(media);
  } else if (kind === 'pdf') { if (headers) { try { url = await previewBlob(url, headers); } catch { return failed(); } } const frame = document.createElement('iframe'); frame.title = name; frame.src = url; content.append(frame); }
  else failed();
}
async function previewBlob(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) { const result = await response.json(); const error = new Error(result.error); error.status = response.status; throw error; }
  const blobUrl = URL.createObjectURL(await response.blob()); previewUrls.add(blobUrl); return blobUrl;
}
async function preview(transfer, file) {
  showDialog('preview-dialog'); $('#preview-title').textContent = file.name;
  const base = `/api/transfers/${transfer.id}/files/${file.id}`;
  if (fileKind(file.name) !== 'zip') return renderMedia(file.name, `${base}/preview`);
  $('#preview-content').innerHTML = '<p class="modal-description">正在读取 ZIP 目录…</p>';
  currentZip = { transfer, file, base, entries: [], token: null };
  try { const result = await api(`${base}/entries`); currentZip.entries = result.entries; renderZip(); }
  catch(error) { if(error.status === 423) renderZipPassword(); else $('#preview-content').textContent = error.message; }
}
function renderZipPassword(message = '') {
  clearPreviewMedia(); currentZip.token = null; $('#preview-title').textContent = currentZip.file.name;
  $('#preview-content').innerHTML = `<div class="zip-unlock"><div class="success-icon">${icon('lock')}</div><h3>输入密码，打开压缩包</h3><p class="modal-description">此 ZIP 已加密，输入解压密码后即可查看和下载内部文件。</p><form id="zip-password-form"><label>解压密码<input id="zip-password" type="password" autocomplete="off" maxlength="256" required placeholder="输入 ZIP 解压密码"></label><p class="form-error" id="zip-password-error" role="alert">${escape(message)}</p><button type="submit" class="primary-button">解锁并查看</button></form></div>`;
  $('#zip-password-form').onsubmit = async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'), archive = currentZip;
    button.disabled = true; button.textContent = '正在解锁…';
    try {
      const result = await api(`${archive.base}/unlock`, { method: 'POST', body: JSON.stringify({ password: $('#zip-password').value }) });
      if (currentZip !== archive || !$('#preview-dialog').open) return;
      $('#zip-password-form').reset(); Object.assign(currentZip, { entries: result.entries, token: result.token }); renderZip();
    } catch(error) { if ($('#zip-password-error')) $('#zip-password-error').textContent = error.message; }
    finally { if(button.isConnected) { button.disabled = false; button.textContent = '解锁并查看'; } }
  };
  $('#zip-password').focus();
}
function renderZip() {
  clearPreviewMedia(); const {file,base,entries,token} = currentZip; $('#preview-title').textContent = file.name;
  $('#preview-content').innerHTML = `<div class="zip-header">${icon('zip')}ZIP 在线目录 · ${entries.length} 项${token ? ' · 已解锁' : ' · 无需下载整个压缩包'}</div>${entries.map(entry => `<div class="zip-entry"><span data-icon="${entry.directory?'folder':fileKind(entry.name)}"></span><span class="entry-name">${escape(entry.name)}</span><span class="entry-size">${entry.directory?'':bytes(entry.size)}</span>${!entry.directory?`<div class="file-actions">${fileKind(entry.name)!=='file' && fileKind(entry.name)!=='zip'?`<button data-entry-preview="${entry.index}" aria-label="预览 ${escape(entry.name)}">${icon('eye')}</button>`:''}${token?`<button data-entry-download="${entry.index}" aria-label="下载 ${escape(entry.name)}">${icon('download')}</button>`:`<a href="${base}/entries/${entry.index}" aria-label="下载 ${escape(entry.name)}">${icon('download')}</a>`}</div>`:''}</div>`).join('') || '<p>压缩包为空。</p>'}`;
  decorate($('#preview-content'));
  const headers = token ? { Authorization: `ZIP ${token}` } : undefined;
  $('#preview-content').querySelectorAll('[data-entry-preview]').forEach(button => button.onclick = () => { const entry = entries[Number(button.dataset.entryPreview)]; renderMedia(entry.name, `${base}/entries/${entry.index}?preview=1`, renderZip, headers); });
  $('#preview-content').querySelectorAll('[data-entry-download]').forEach(button => button.onclick = async () => {
    const entry = entries[Number(button.dataset.entryDownload)]; button.disabled = true;
    try {
      const response = await fetch(`${base}/entries/${entry.index}`, { headers });
      if (!response.ok) { const result = await response.json(); if(response.status === 423) return renderZipPassword(result.error); throw new Error(result.error); }
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = entry.name.split('/').pop(); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch(error) { toast(error.message); } finally {button.disabled = false;}
  });
}
async function showHistory(targetPage = 1) {
  if (!user) return openAuth('login', () => showHistory());
  page = targetPage; setView('history'); $('#hero h1').innerHTML = '分享过的，<span>都在这里。</span>'; $('#hero>p').textContent = '查看、复制链接，或让文件提前离开。';
  const panel = $('#history-panel'); panel.innerHTML = '<div class="empty-state"><p>正在获取历史文件…</p></div>';
  try {
    const result = await api(`/api/history?page=${page}`);
    panel.innerHTML = `<div class="history-heading"><h2>我的文件 <span class="badge">${result.total} 次分享</span></h2><a class="text-button" href="/">+ 上传文件</a></div>${result.transfers.map(t => `<article class="history-card"><h3>${escape(t.files[0].name)}${t.files.length>1?` 等 ${t.files.length} 个文件`:''}</h3><div class="history-meta"><span>${bytes(t.totalSize)}</span><span>上传于 ${date(t.createdAt)}</span><span class="${!activeTransfer(t)?'expired':''}">${!activeTransfer(t)?'已过期，等待清理':expiryText(t)}</span></div><div class="history-actions">${activeTransfer(t)?`<a class="secondary-button" href="/s/${t.id}" target="_blank">查看 / 预览</a><button class="secondary-button" data-history-copy="${t.id}">复制链接</button>`:''}<button class="danger-button" data-delete="${t.id}">${icon('trash')}删除</button></div></article>`).join('') || '<div class="empty-state"><div class="success-icon">'+icon('folder')+'</div><p>还没有上传记录。<br>登录后上传的文件会出现在这里。</p><a class="primary-button" href="/">分享第一个文件</a></div>'}${result.total>20?`<div class="pagination"><button class="secondary-button" id="previous-page" ${page===1?'disabled':''}>上一页</button><span>${page} / ${Math.ceil(result.total/20)}</span><button class="secondary-button" id="next-page" ${page*20>=result.total?'disabled':''}>下一页</button></div>`:''}`;
    panel.querySelectorAll('[data-history-copy]').forEach(b => b.onclick = () => copy(shareUrl({id:b.dataset.historyCopy})));
    panel.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => { pendingDelete = b.dataset.delete; showDialog('confirm-dialog'); });
    if ($('#previous-page')) $('#previous-page').onclick = () => showHistory(page-1);
    if ($('#next-page')) $('#next-page').onclick = () => showHistory(page+1);
  } catch(error) { panel.innerHTML = `<div class="empty-state"><p>${escape(error.message)}</p><a href="/" class="secondary-button">返回首页</a></div>`; }
}
function openAuth(mode = 'login', next = null) { authNext = next; changeAuthMode(mode); showDialog('auth-dialog'); }
function changeAuthMode(mode) {
  authMode = mode; $('#login-tab').classList.toggle('active', mode === 'login'); $('#register-tab').classList.toggle('active', mode === 'register');
  $('#auth-title').textContent = mode === 'login'?'欢迎回来':'开始你的分享'; $('#auth-description').textContent = mode === 'login'?'登录，管理你分享过的文件。':'创建普通账号，留住每一次分享记录。';
  $('#auth-submit').textContent = mode === 'login'?'登录':'注册并登录'; $('#auth-password').autocomplete = mode === 'login'?'current-password':'new-password'; $('#auth-error').textContent = '';
}
async function showSettings() {
  if (!user) return openAuth('login', showSettings);
  showDialog('settings-dialog');
  const content = $('#settings-content');
  if (user.role !== 'admin') { content.innerHTML = `<div class="empty-state"><div class="success-icon">${icon('lock')}</div><p>你已登录普通账号。<br>站点设置与系统升级由管理员管理。</p><button class="secondary-button" id="settings-my-files">查看我的文件</button></div>`; $('#settings-my-files').onclick = () => { closeDialog('settings-dialog'); showHistory(); }; return; }
  content.innerHTML = '<p class="modal-description">正在加载设置…</p>';
  try {
    const result = await api('/api/admin/settings'), s = result.settings;
    content.innerHTML = `<form id="settings-form"><label>站点名称<input name="siteName" value="${escape(s.siteName)}" maxlength="30" required></label><div class="settings-grid"><label>默认保留时间（小时）<input name="retentionHours" type="number" min="1" max="8760" value="${s.retentionHours}" required></label><label>清理周期（小时）<input name="cleanupIntervalHours" type="number" min="1" max="168" value="${s.cleanupIntervalHours}" required></label></div><label>分享域名（可留空）<input name="publicUrl" value="${escape(s.publicUrl)}" placeholder="https://files.example.com"></label><p class="settings-help">新设置仅影响之后的上传。到期链接立即失效，磁盘文件按清理周期删除。${config.publicUrl && config.publicUrl !== s.publicUrl?'部署环境变量中的域名优先。':''}</p><p class="form-error" id="settings-error" role="alert"></p><button class="primary-button" type="submit">保存设置</button></form><div class="settings-section"><h3>磁盘与文件存储</h3><div id="storage-stats"></div><p class="settings-help">读取上传目录所在宿主机磁盘的实际空间，包含系统和其他程序占用。每 5 秒刷新；上传时逐块检查并每秒巡检，达到 95% 自动停止。</p><button class="secondary-button" id="refresh-storage">刷新磁盘空间</button> <button class="secondary-button" id="cleanup-now">${icon('clock')}立即清理过期文件</button></div><div class="settings-section"><h3>系统升级 <span class="badge">仅管理员</span></h3><div class="update-box"><div class="update-header"><span>当前版本</span><span class="version-pill">v${result.version}</span></div><p id="update-message" class="update-message"></p><pre id="release-notes" class="release-notes" hidden></pre><div class="settings-buttons"><button class="secondary-button" id="check-update">检查更新</button><button class="primary-button" id="run-update" disabled>一键升级</button></div></div><p class="settings-help">更新会短暂重启服务。数据保持不变，启动失败自动回滚。</p></div>`;
    renderStats(result.stats);
    $('#settings-form').onsubmit = async event => {
      event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
      ['retentionHours','cleanupIntervalHours'].forEach(k => values[k] = Number(values[k]));
      const submit = form.querySelector('[type=submit]'); submit.disabled = true;
      try { const saved = await api('/api/admin/settings',{method:'PUT',body:JSON.stringify(values)}); renderStats(saved.stats); applyConfig(await api('/api/config')); $('#settings-error').textContent = ''; toast('设置已保存'); }
      catch(error) { $('#settings-error').textContent = error.message; } finally { submit.disabled = false; }
    };
    $('#cleanup-now').onclick = async event => {
      event.currentTarget.disabled = true;
      try { const cleaned = await api('/api/admin/cleanup',{method:'POST'}); renderStats(cleaned.stats); toast(`已清理 ${cleaned.deletedTransfers} 次分享，释放 ${bytes(cleaned.deletedBytes)}`); }
      catch(error) { toast(error.message); } finally { $('#cleanup-now').disabled = false; }
    };
    $('#check-update').disabled = !result.updateEnabled;
    $('#update-message').textContent = result.updateEnabled?'点击检查，获取最新正式版本。':'本地开发模式。使用配套 Docker Compose 部署可启用在线升级。';
    if (result.update.phase !== 'idle') renderUpdate(result.update);
    if (!['idle','success','failed','rolled_back'].includes(result.update.phase)) startPolling();
    $('#check-update').onclick = checkUpdate; $('#run-update').onclick = runUpdate;
    $('#refresh-storage').onclick = refreshStorage;
    clearInterval(storagePoll); storagePoll = setInterval(refreshStorage, 5000);
  } catch(error) { content.innerHTML = `<p class="form-error">${escape(error.message)}</p>`; }
}
function renderStats(stats) {
  const disk = stats.disk;
  $('#storage-stats').innerHTML = `<div class="stats-grid"><div><div class="stat-value">${bytes(disk.totalBytes)}</div><div class="stat-label">磁盘总容量</div></div><div><div class="stat-value">${bytes(disk.usedBytes)}</div><div class="stat-label">磁盘已用空间</div></div><div><div class="stat-value" id="disk-available">${bytes(disk.availableBytes)}</div><div class="stat-label">磁盘剩余可用</div></div></div><p class="settings-help ${disk.uploadAllowed ? '' : 'expired'}" id="disk-status">磁盘使用率 ${disk.usedPercent.toFixed(2)}% · ${disk.uploadAllowed ? '可以上传，达到 95% 自动停止' : '已暂停上传，请清理磁盘空间'}</p><p class="settings-help">分享文件 ${bytes(stats.usedBytes)} · 有效分享 ${stats.activeTransfers} · 待清理 ${stats.expiredTransfers}<br>上次清理 ${stats.lastCleanupAt?date(stats.lastCleanupAt):'尚未运行'} · 下次 ${date(stats.nextCleanupAt)}</p>`;
}
async function refreshStorage() {
  if (!$('#settings-dialog').open || !$('#storage-stats')) return;
  try { const result = await api('/api/admin/storage'); if ($('#storage-stats')) renderStats(result.stats); }
  catch(error) { if ($('#disk-status')) $('#disk-status').textContent = `磁盘信息刷新失败：${error.message}`; }
}
async function checkUpdate() {
  $('#check-update').disabled = true; $('#update-message').textContent = '正在检查最新版本…';
  try { const result = await api('/api/admin/version'); $('#update-message').textContent = result.available?`发现新版本 v${result.latest}，现在可以升级。`:'当前已是最新正式版本。'; $('#run-update').disabled = !result.available; $('#release-notes').textContent = result.notes; $('#release-notes').hidden = !result.notes; }
  catch(error) { $('#update-message').textContent = error.message; } finally { $('#check-update').disabled = false; }
}
function renderUpdate(state) {
  if (!$('#update-message')) return;
  $('#update-message').textContent = `${state.message || ''}${state.targetVersion?` · v${state.targetVersion}`:''}`;
  const running = !['idle','success','failed','rolled_back'].includes(state.phase);
  $('#check-update').disabled = running; $('#run-update').disabled = true;
  if (state.phase === 'success') { $('#footer-version').textContent = `v${state.targetVersion}`; const pill = $('.version-pill'); if(pill) pill.textContent = `v${state.targetVersion}`; }
}
function startPolling() {
  clearInterval(updatePoll); let failures = 0;
  updatePoll = setInterval(async () => {
    try { const state = await api('/api/admin/update'); failures = 0; renderUpdate(state); if (['success','failed','rolled_back'].includes(state.phase)) { clearInterval(updatePoll); updatePoll = null; if(state.phase==='success') toast('系统升级完成'); } }
    catch { failures++; if ($('#update-message')) $('#update-message').textContent = failures < 60?'服务正在重启，自动等待恢复…':'暂时无法连接，请稍后重新打开设置查看结果。'; if(failures>=60) clearInterval(updatePoll); }
  }, 3000);
}
async function runUpdate() {
  $('#run-update').disabled = true; $('#check-update').disabled = true; $('#update-message').textContent = '正在启动升级任务…';
  try { renderUpdate(await api('/api/admin/update',{method:'POST'})); startPolling(); }
  catch(error) { $('#update-message').textContent = error.message; $('#check-update').disabled = false; }
}
decorate();
try { setTheme(localStorage.getItem('xiazai-theme') || 'light'); } catch { setTheme('light'); }
$('#theme-button').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark'?'light':'dark');
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => closeDialog(button.dataset.close));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
$('#preview-dialog').addEventListener('close', () => { clearPreviewMedia(); $('#preview-content').replaceChildren(); currentZip = null; });
$('#settings-dialog').addEventListener('close', () => { clearInterval(updatePoll); updatePoll = null; clearInterval(storagePoll); storagePoll = null; });
$('#select-button').onclick = event => { event.stopPropagation(); $('#file-input').click(); };
$('#dropzone').onclick = () => $('#file-input').click();
$('#dropzone').onkeydown = event => { if(event.key==='Enter' || event.key===' ') { event.preventDefault(); $('#file-input').click(); } };
$('#file-input').onchange = event => upload(event.target.files);
let dragDepth = 0;
$('#dropzone').ondragenter = event => { event.preventDefault(); dragDepth++; $('#dropzone').classList.add('dragging'); };
$('#dropzone').ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; };
$('#dropzone').ondragleave = event => { event.preventDefault(); if(--dragDepth<=0) $('#dropzone').classList.remove('dragging'); };
$('#dropzone').ondrop = event => { event.preventDefault(); dragDepth = 0; $('#dropzone').classList.remove('dragging'); upload(event.dataTransfer.files); };
window.addEventListener('dragover', event => event.preventDefault()); window.addEventListener('drop', event => event.preventDefault());
$('#cancel-upload').onclick = () => request?.abort(); $('#send-more').onclick = resetUpload;
$('#copy-link').onclick = async () => { if(await copy($('#share-url').value)) $('#copy-label').textContent = '已复制'; };
$('#account-button').onclick = () => { if(!user) return openAuth(); $('#account-info').textContent = `${user.username} · ${user.role==='admin'?'管理员':'普通账号'}`; $('#password-error').textContent = ''; showDialog('account-dialog'); };
$('#login-tab').onclick = () => changeAuthMode('login'); $('#register-tab').onclick = () => changeAuthMode('register');
$('#auth-form').onsubmit = async event => {
  event.preventDefault(); $('#auth-submit').disabled = true;
  try { const result = await api(`/api/auth/${authMode}`,{method:'POST',body:JSON.stringify({username:$('#auth-username').value,password:$('#auth-password').value})}); updateUser(result.user); closeDialog('auth-dialog'); $('#auth-form').reset(); toast(authMode==='login'?'登录成功':'注册成功'); const next = authNext; authNext = null; next?.(); }
  catch(error) { $('#auth-error').textContent = error.message; } finally { $('#auth-submit').disabled = false; }
};
$('#logout-button').onclick = async () => { try { await api('/api/auth/logout',{method:'POST'}); updateUser(null); closeDialog('account-dialog'); toast('已退出登录'); if(!$('#history-panel').hidden) location.href='/'; } catch(error){toast(error.message);} };
$('#password-form').onsubmit = async event => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try { await api('/api/auth/password',{method:'PUT',body:JSON.stringify({currentPassword:$('#current-password').value,newPassword:$('#new-password').value})}); updateUser(null); closeDialog('account-dialog'); $('#password-form').reset(); toast('密码已修改，请重新登录'); openAuth(); }
  catch(error) { $('#password-error').textContent = error.message; } finally { button.disabled = false; }
};
$('#history-button').onclick = () => showHistory(); $('#settings-button').onclick = showSettings;
$('#confirm-delete').onclick = async () => { const button = $('#confirm-delete'); button.disabled = true; try { await api(`/api/history/${pendingDelete}`,{method:'DELETE'}); closeDialog('confirm-dialog'); toast('文件已删除'); showHistory(page); } catch(error) { toast(error.message); } finally { button.disabled = false; } };
window.addEventListener('beforeunload', event => { if(request) { event.preventDefault(); event.returnValue = ''; } });
Promise.all([api('/api/config'), api('/api/auth/me')]).then(([next,account]) => { applyConfig(next); updateUser(account.user); const share = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/); if(share) renderShare(share[1]); }).catch(error => { $('#upload-limit').textContent = '服务连接失败，请刷新页面'; toast(error.message); });
