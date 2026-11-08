import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Docker } from '../updater/docker.mjs';
import { Updater } from '../updater/service.mjs';

const image=process.argv[2]; if(!image) throw new Error('Pass Docker image');
const root=await mkdtemp(path.join(os.tmpdir(),'xiazai-real-update-')), name=`xiazai-upgrade-${Date.now()}`, network=`${name}-net`;
const cmd=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const client=new Docker();
// The published manifest/fetch/digest protocol is verified separately. This smoke uses a prebuilt image
// to exercise real Docker create/stop/rename/start/healthcheck/remove and rollback operations.
client.pull=async target=>{cmd('image','inspect',target);};
try {
  cmd('network','create',network);
  cmd('run','-d','--name',name,'--network',network,'--network-alias','app','--label','org.opencontainers.image.version=1.0.0',
    '--user',`${process.getuid()}:${process.getgid()}`,'-p','127.0.0.1::8080','-e','DATA_DIR=/data','-e','ADMIN_PASSWORD=real-update-password','-v',`${root}:/data`,image);
  await mkdir(path.join(root,'deploy'),{recursive:true}); await writeFile(path.join(root,'deploy','.env'),`APP_IMAGE=${image}\nUPDATER_IMAGE=${image}\n`);
  const updater=new Updater({docker:client,root,appName:name,releaseFetcher:async()=>({version:'1.1.0',image}),wait:sleep});
  await updater.health(name);
  const initial=await client.inspect(name), port=initial.NetworkSettings.Ports['8080/tcp'][0].HostPort;
  const base=`http://127.0.0.1:${port}`;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'real-update-password'})}); assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const form=new FormData(); form.append('files',new Blob(['survives upgrade and rollback']),'preserved.txt');
  const upload=await fetch(base+'/api/upload',{method:'POST',headers:{Cookie:cookie},body:form}); assert.equal(upload.status,201); const transfer=await upload.json();
  await updater.run(await updater.prepare('1.1.0'));
  assert.equal((await updater.state()).phase,'success');
  const upgraded=await client.inspect(name); assert.notEqual(upgraded.Id,initial.Id); assert.equal(upgraded.Config.Labels['org.opencontainers.image.version'],'1.1.0');
  assert.equal(upgraded.NetworkSettings.Ports['8080/tcp'][0].HostPort,port);
  assert.equal(await(await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`)).text(),'survives upgrade and rollback');
  assert.equal((await fetch(base+'/api/history',{headers:{Cookie:cookie}})).status,200);
  updater.releaseFetcher=async()=>({version:'1.2.0',image});
  const realHealth=updater.health.bind(updater);
  updater.health=async target=>{if(target!==upgraded.Id) throw new Error('simulated unhealthy candidate'); return realHealth(target);};
  await updater.run(await updater.prepare('1.2.0'));
  assert.equal((await updater.state()).phase,'rolled_back'); assert.equal((await client.inspect(name)).Id,upgraded.Id);
  assert.equal(await(await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`)).text(),'survives upgrade and rollback');
  assert.ok((await readFile(path.join(root,'deploy','.env'),'utf8')).includes(`APP_IMAGE=${image}`));
  console.log('Real Docker updater smoke passed: container replacement, healthcheck, preserved ports/network/files/accounts/sessions and rollback.');
} finally {
  const containers=cmd('ps','-a','--format','{{.Names}}').split('\n').filter(n=>n===name||n.startsWith(name+'-backup-')||n.startsWith(name+'-candidate-'));
  for(const container of containers) try{cmd('rm','-f',container);}catch{}
  try{cmd('network','rm',network);}catch{} await rm(root,{recursive:true,force:true});
}
