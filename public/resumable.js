/* Persistent browser resume receipts hold only filenames, fingerprints and a scoped upload token. */
(() => {
  const storageKey = 'xiazai-resumable-v1';
  const interrupted = () => new DOMException('Upload paused', 'AbortError');
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(interrupted());
    const aborted = () => { clearTimeout(timer); reject(interrupted()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
  function receipts() {
    try { const value = JSON.parse(localStorage.getItem(storageKey) || '[]'); return Array.isArray(value) ? value.filter(r => r?.expiresAt > Date.now()).slice(-20) : []; } catch { return []; }
  }
  function save(record) {
    try { const records = receipts().filter(r => r.id !== record.id); records.push(record); localStorage.setItem(storageKey, JSON.stringify(records.slice(-20))); } catch {}
  }
  function forget(id) { try { localStorage.setItem(storageKey, JSON.stringify(receipts().filter(r => r.id !== id))); } catch {} }
  function randomId() {return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replaceAll('+','-').replaceAll('/','_');}
  async function signature(files) {
    const values = [];
    for (const file of files) {
      const bytes = new Uint8Array(await new Blob([file.slice(0, 65536), file.slice(Math.max(0, Math.floor(file.size / 2) - 32768), Math.floor(file.size / 2) + 32768), file.slice(Math.max(0, file.size - 65536))]).arrayBuffer());
      let fingerprint;
      if (globalThis.crypto?.subtle) fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      else {
        // HTTP origins do not expose WebCrypto. A pair of hashes plus metadata helps detect a wrong local file.
        let a = 2166136261, b = 5381;
        for (const byte of bytes) { a = Math.imul(a ^ byte, 16777619); b = Math.imul(b, 33) ^ byte; }
        fingerprint = `${a >>> 0}-${b >>> 0}`;
      }
      values.push({ name: file.name, size: file.size, lastModified: file.lastModified, fingerprint });
    }
    return JSON.stringify(values);
  }
  async function json(url, options = {}) {
    let response;
    try { response = await fetch(url, options); } catch (error) { error.retryable = true; throw error; }
    let value;
    try { value = await response.json(); } catch { value = null; }
    if (!response.ok) {
      const error = new Error(value?.error || (response.status === 413 ? '当前分块被代理限制，请减小请求或检查代理配置' : '服务连接中断，请继续上传'));
      error.status = response.status; error.retryable = [408,409,429,500,502,503,504].includes(response.status); throw error;
    }
    if (!value) { const error = new Error('上传服务返回了无效响应，请重试'); error.retryable = true; throw error; }
    return value;
  }
  function sendChunk(url, blob, token, offset, checksum, signal, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('PUT', url); xhr.responseType = 'json'; xhr.timeout = 120000;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('Authorization', `Upload ${token}`); xhr.setRequestHeader('Upload-Offset', String(offset));
      if (checksum) xhr.setRequestHeader('Upload-Checksum', checksum);
      const aborted = () => xhr.abort(); signal.addEventListener('abort', aborted, { once: true });
      const finish = (error, value) => { signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(value); };
      xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) return finish(null, xhr.response);
        const error = new Error(xhr.response?.error || `上传分块失败（${xhr.status}），已保留确认进度`);
        error.status = xhr.status; error.retryable = [0,408,409,422,429,500,502,503,504].includes(xhr.status); finish(error);
      };
      xhr.onerror = xhr.ontimeout = () => { const error = new Error('网络连接中断，已保留上传进度'); error.retryable = true; finish(error); };
      xhr.onabort = () => finish(interrupted());
      if (signal.aborted) return finish(interrupted()); xhr.send(blob);
    });
  }
  class ResumableClient {
    constructor(files, hours, owner, hooks = {}) { this.files = Array.from(files); this.hours = hours; this.owner = owner || null; this.hooks = hooks; this.record = null; this.active = false; this.chunkBytes = 4 * 1024 ** 2; }
    async request(url, options) {
      for (let attempt = 0; ; attempt++) {
        try { return await json(url, { ...options, signal: this.controller.signal }); }
        catch (error) {
          if (this.controller.signal.aborted) throw interrupted();
          if (!error.retryable || attempt >= 4) throw error;
          this.hooks.message?.(`连接中断，正在重试（${attempt + 1}/4）…`); await sleep(Math.min(1000 * 2 ** attempt, 8000), this.controller.signal);
        }
      }
    }
    async start() {
      if (this.active) return;
      this.active = true; this.controller = new AbortController();
      try {
        const key = await signature(this.files); this.controller.signal.throwIfAborted();
        if (!this.record) this.record = receipts().find(r => r.key === key && r.hours === this.hours && r.owner === this.owner) || null;
        let state;
        if (this.record) {
          try { state = await this.request(`/api/uploads/${this.record.id}`, { headers: { Authorization: `Upload ${this.record.token}` } }); }
          catch (error) { if (![404,410].includes(error.status)) throw error; forget(this.record.id); this.record = null; }
        }
        if (!this.record) {
          const requestId=randomId(), token=randomId()+randomId();
          // Store the scoped receipt before creation so refresh/pause during a lost response can recover it.
          this.record = {id:requestId,token,expiresAt:Date.now()+86400000,key,hours:this.hours,owner:this.owner};save(this.record);
          state = await this.request('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId,token,hours: this.hours, files: this.files.map(file => ({ name: file.name, size: file.size })) }) });
          this.record = { id: state.id, token: state.token, expiresAt: state.expiresAt, key, hours: this.hours, owner: this.owner }; save(this.record);
        }
        const headers = { Authorization: `Upload ${this.record.token}` }, total = this.files.reduce((n, f) => n + f.size, 0);
        if (!state.complete) {this.hooks.ready?.(state.transfer);this.hooks.progress?.(state.files.reduce((n, f) => n + f.offset, 0), total);}
        for (let index = 0; !state.complete && index < this.files.length; index++) {
          let attempts = 0;
          while (state.files[index].offset < this.files[index].size) {
            this.controller.signal.throwIfAborted();
            const confirmed = state.files.reduce((n, f) => n + f.offset, 0), file = state.files[index], offset = file.offset;
            const blob = this.files[index].slice(offset, Math.min(offset + this.chunkBytes, file.size));
            let checksum;
            if (globalThis.crypto?.subtle) checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
            try {
              this.hooks.message?.('正在分块上传…');
              const result = await sendChunk(`/api/uploads/${this.record.id}/files/${file.id}`, blob, this.record.token, offset, checksum, this.controller.signal, loaded => this.hooks.progress?.(confirmed + loaded, total));
              if (result.offset <= offset || result.offset > file.size) throw new Error('服务器上传进度异常');
              state.files[index].offset = result.offset; attempts = 0;
              this.record.expiresAt = Date.now() + 86400000; save(this.record); this.hooks.progress?.(state.files.reduce((n, f) => n + f.offset, 0), total);
            } catch (error) {
              if (this.controller.signal.aborted) throw interrupted();
              if (error.status === 413 && this.chunkBytes > 256 * 1024) { this.chunkBytes = Math.floor(this.chunkBytes / 2); }
              else if (!error.retryable || attempts >= 4) { if ([404,410,507].includes(error.status)) forget(this.record.id); throw error; }
              attempts++; this.hooks.message?.(`正在恢复断点（${attempts}/4）…`); await sleep(Math.min(1000 * 2 ** (attempts - 1), 8000), this.controller.signal);
              state = await this.request(`/api/uploads/${this.record.id}`, { headers });
              if (state.complete) break;
            }
          }
        }
        if (!state.complete) { this.hooks.message?.('正在确认文件完整性…'); state = await this.request(`/api/uploads/${this.record.id}/complete`, { method: 'POST', headers }); }
        forget(this.record.id); this.hooks.complete?.(state.transfer); this.record = null;
      } catch (error) { if(this.record && [404,410,507].includes(error.status))forget(this.record.id); if (error.name !== 'AbortError') this.hooks.error?.(error); else this.hooks.paused?.(); }
      finally { this.active = false; }
    }
    pause() { this.controller?.abort(); }
    async cancel() {
      this.pause();
      if (!this.record) return;
      const record = this.record;
      for (let attempt = 0; attempt < 6; attempt++) {
        try { await json(`/api/uploads/${record.id}`, { method: 'DELETE', headers: { Authorization: `Upload ${record.token}` } }); forget(record.id); this.record = null; return; }
        catch (error) { if ([404,410].includes(error.status)) { forget(record.id); this.record = null; return; } if (error.status !== 409 || attempt === 5) throw error; await new Promise(r => setTimeout(r, 250)); }
      }
    }
    static hasPending() { return receipts().length > 0; }
  }
  window.ResumableClient = ResumableClient;
})();
