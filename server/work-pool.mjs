import { httpError } from './util.mjs';

export class WorkPool {
  constructor(concurrency, maxWaiting = 16) { this.concurrency = concurrency; this.maxWaiting = maxWaiting; this.active = 0; this.waiting = []; }
  async run(action) {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) throw httpError(429, '当前处理请求较多，请稍后重试');
      await new Promise(resolve => this.waiting.push(resolve));
    } else this.active++;
    try { return await action(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}
