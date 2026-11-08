import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const image=process.argv[2]; if(!image) throw new Error('Pass Docker image as first argument');
const root=await mkdtemp(path.join(os.tmpdir(),'xiazai-docker-smoke-'));
const name=`xiazai-smoke-${Date.now()}`;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  try { docker('image','inspect',image); } catch { docker('pull',image); }
  const userArgs=process.getuid?['--user',`${process.getuid()}:${process.getgid()}`]:[];
  docker('run','-d','--name',name,...userArgs,'-p','127.0.0.1::8080','-e','ADMIN_PASSWORD=docker-smoke-password','-e','DATA_DIR=/data','-v',`${root}:/data`,image);
  const ports=JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['8080/tcp'];
  const base=`http://127.0.0.1:${ports[0].HostPort}`;
  let healthy=false;
  for(let attempt=0;attempt<40;attempt++) {
    const state=JSON.parse(docker('inspect',name))[0].State;
    if(!state.Running) throw new Error(docker('logs',name));
    if(state.Health?.Status==='healthy') {healthy=true;break;} await sleep(2000);
  }
  assert.ok(healthy,'Docker app must become healthy');
  assert.equal((await fetch(base+'/api/health')).status,200);
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'docker-smoke-password'})}); assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const body=new FormData(); body.append('files',new Blob(['Docker persistence smoke']),'docker.txt');
  const response=await fetch(base+'/api/upload',{method:'POST',body,headers:{Cookie:cookie}}); assert.equal(response.status,201); const transfer=await response.json();
  docker('restart',name);
  for(let attempt=0;attempt<30;attempt++) {try {if((await fetch(base+'/api/health')).ok)break;}catch{} await sleep(1000);}
  assert.equal(await (await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`)).text(),'Docker persistence smoke');
  assert.equal((await fetch(base+'/api/history',{headers:{Cookie:cookie}})).status,200);
  console.log('Docker smoke passed: startup, healthcheck, admin login, upload, persistent files and session after restart.');
} catch(error) { try {console.error(docker('logs',name));}catch{} throw error; }
finally {try {docker('rm','-f',name);}catch{} await rm(root,{recursive:true,force:true});}
