import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Auth, validateUsername, validatePassword, passwordHash } from '../server/auth.mjs';
import { id, readJson, atomicJson } from '../server/util.mjs';

// Offline command: caller must stop the app before resetting its persisted database.
let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const payload = JSON.parse(input);
validateUsername(payload.username); validatePassword(payload.password);
const root = path.resolve(process.env.DATA_DIR || '/data');
await mkdir(root,{recursive:true});
const file = path.join(root,'accounts.json'), db = await readJson(file,{users:[],sessions:[]});
const admin = db.users.find(u => u.role==='admin');
if (admin && !payload.reset) throw new Error('管理员已存在，请使用重置脚本');
if (db.users.some(u => u.username.toLowerCase()===payload.username.toLowerCase() && u.id!==admin?.id)) throw new Error('该用户名已被其他用户使用');
if (admin) {
  admin.username = payload.username; admin.password = await passwordHash(payload.password);
  db.sessions = db.sessions.filter(s => s.userId!==admin.id);
} else db.users.push({id:id(),username:payload.username,password:await passwordHash(payload.password),role:'admin',createdAt:Date.now()});
await atomicJson(file,db);
console.log(payload.reset?'管理员密码已重置，原管理员会话已失效。':'管理员账号已初始化。');
