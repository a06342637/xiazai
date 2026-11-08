import http from 'node:http';
import { secretEqual } from '../server/util.mjs';
import { isVersion } from '../server/releases.mjs';
import { Docker } from './docker.mjs';
import { Updater } from './service.mjs';

const key = process.env.UPDATE_KEY;
if (!key || key.length < 24 || key.startsWith('replace-with')) throw new Error('UPDATE_KEY must be a random secret of at least 24 characters');
const updater = new Updater({docker:new Docker(),root:process.env.DATA_DIR || '/data',appName:process.env.APP_CONTAINER || 'xiazai'});
await updater.recover();
const server = http.createServer(async (req,res) => {
  const respond = (status,value) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
  if (!secretEqual(req.headers.authorization?.replace(/^Bearer /,''),key)) { req.resume(); return respond(401,{error:'Unauthorized'}); }
  if (req.method !== 'POST' || req.url !== '/update') { req.resume(); return respond(404,{error:'Not found'}); }
  try {
    let body = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if(size>4096) throw Object.assign(new Error('请求过大'),{status:413}); body += chunk; }
    let payload; try { payload = JSON.parse(body); } catch { throw Object.assign(new Error('请求格式无效'),{status:400}); }
    if (!isVersion(payload.version)) throw Object.assign(new Error('版本号格式无效'),{status:400});
    const prepared = await updater.prepare(payload.version); respond(202,prepared.state);
    updater.run(prepared).catch(error => console.error(error.message));
  } catch(error) { respond(error.status || 500,{error:error.message}); }
});
server.listen(8081,'0.0.0.0',() => console.log('xiazai updater ready'));
server.requestTimeout = 30000; server.headersTimeout = 15000;
