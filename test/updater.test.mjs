import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Updater } from '../updater/service.mjs';
import { cloneConfig } from '../updater/docker.mjs';

const image=`ghcr.io/a06342637/xiazai@sha256:${'a'.repeat(64)}`;
function original() { return {Id:'old',Name:'/xiazai',Config:{Image:'old-image',Labels:{'org.opencontainers.image.version':'1.0.0'},
  Env:['DATA_DIR=/data','UPDATE_KEY=example'],ExposedPorts:{'8080/tcp':{}},Cmd:['old-command'],Healthcheck:{Test:['CMD','old-health']}},
  HostConfig:{Binds:['/root/xiazai:/data'],RestartPolicy:{Name:'unless-stopped'},PortBindings:{'8080/tcp':[{HostPort:'8080'}]}},
  NetworkSettings:{Networks:{backend:{Aliases:['xiazai','app'],IPAddress:'172.18.0.2'}}},State:{Running:true,Health:{Status:'healthy'}}}; }
class FakeDocker {
  constructor({unhealthy=false,pullError=false}={}) { this.containers = new Map([['old',original()]]); this.unhealthy=unhealthy; this.pullError=pullError; this.calls=[]; }
  async inspect(name) { const c=[...this.containers.values()].find(c=>c.Id===name||c.Name===`/${name}`); if(!c) throw Object.assign(new Error('missing'),{status:404}); return structuredClone(c); }
  async pull() { this.calls.push('pull'); if(this.pullError) throw new Error('network down'); }
  async create(name,config) { this.calls.push('create'); this.createdConfig=config; this.containers.set('new',{...original(),Id:'new',Name:`/${name}`,Config:config,State:{Running:false,Health:{Status:this.unhealthy?'unhealthy':'healthy'}}}); return {Id:'new'}; }
  async rename(name,replacement) { this.calls.push(`rename:${name}:${replacement}`); const c=await this.inspect(name); this.containers.get(c.Id).Name=`/${replacement}`; }
  async stop(name) { this.calls.push(`stop:${name}`); const c=await this.inspect(name); this.containers.get(c.Id).State.Running=false; }
  async start(name) { this.calls.push(`start:${name}`); const c=await this.inspect(name); this.containers.get(c.Id).State.Running=true; }
  async remove(name) { this.calls.push(`remove:${name}`); const c=await this.inspect(name); this.containers.delete(c.Id); }
}
async function fixture(t,options={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'xiazai-update-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const docker=new FakeDocker(options), updater=new Updater({root,docker,wait:async()=>{},healthAttempts:1,releaseFetcher:async()=>({version:'1.1.0',image})});
  return {root,docker,updater};
}
test('update preserves mount, port, env and network; commits digest after healthcheck',async t => {
  const {root,docker,updater}=await fixture(t);
  await mkdir(path.join(root,'deploy')); await writeFile(path.join(root,'deploy','.env'),'APP_IMAGE=old\nUPDATER_IMAGE=old-updater\n');
  const prepared=await updater.prepare('1.1.0'); await assert.rejects(updater.prepare('1.1.0'),/正在运行/);
  await updater.run(prepared);
  assert.equal((await updater.state()).phase,'success'); assert.equal(docker.containers.size,1);
  assert.equal((await docker.inspect('xiazai')).Id,'new');
  assert.deepEqual(docker.createdConfig.HostConfig.Binds,['/root/xiazai:/data']);
  assert.deepEqual(docker.createdConfig.Env,original().Config.Env); assert.deepEqual(docker.createdConfig.NetworkingConfig.EndpointsConfig.backend.Aliases,['xiazai','app']);
  assert.equal(docker.createdConfig.Cmd,undefined); assert.equal(docker.createdConfig.Healthcheck,undefined);
  const env=await readFile(path.join(root,'deploy','.env'),'utf8'); assert.ok(env.includes(`APP_IMAGE=${image}`)); assert.ok(env.includes('UPDATER_IMAGE=old-updater'));
});
test('unhealthy new image rolls back old container without deleting persistent data',async t => {
  const {root,docker,updater}=await fixture(t,{unhealthy:true});
  await writeFile(path.join(root,'sentinel'),'persistent files');
  await updater.run(await updater.prepare('1.1.0'));
  assert.equal((await updater.state()).phase,'rolled_back'); assert.equal((await docker.inspect('xiazai')).Id,'old'); assert.ok((await docker.inspect('xiazai')).State.Running);
  assert.equal(await readFile(path.join(root,'sentinel'),'utf8'),'persistent files'); assert.equal(docker.containers.size,1);
});
test('pull failure leaves running old version untouched',async t => {
  const {docker,updater}=await fixture(t,{pullError:true}); await updater.run(await updater.prepare('1.1.0'));
  assert.equal((await updater.state()).phase,'failed'); assert.equal((await docker.inspect('xiazai')).Id,'old'); assert.deepEqual(docker.calls,['pull']);
});
test('interrupted switching task recovers backup and removes orphan candidate',async t => {
  const {docker,updater}=await fixture(t), prepared=await updater.prepare('1.1.0');
  await updater.save('switching','interrupted');
  await docker.create(updater.job.candidateName,cloneConfig(prepared.original,image));
  await docker.stop('old'); await docker.rename('old',updater.job.backupName);
  await updater.recover(); assert.equal((await updater.state()).phase,'rolled_back'); assert.equal(docker.containers.size,1); assert.equal((await docker.inspect('xiazai')).Id,'old');
});

test('Docker stop timeout restores an original container that actually stopped',async t=>{
  const {docker,updater}=await fixture(t);const stop=docker.stop.bind(docker);
  docker.stop=async name=>{await stop(name);throw new Error('response timed out after stopping');};
  await updater.run(await updater.prepare('1.1.0'));
  assert.equal((await docker.inspect('xiazai')).Id,'old');assert.equal((await docker.inspect('xiazai')).State.Running,true);
  assert.equal(docker.containers.size,1);
});

test('Docker rename timeout restores a backup created before the failed response',async t=>{
  const {docker,updater}=await fixture(t);const rename=docker.rename.bind(docker);let failed=false;
  docker.rename=async(name,replacement)=>{await rename(name,replacement);if(!failed&&name==='old'&&replacement.includes('backup')){failed=true;throw new Error('response timed out after rename');}};
  await updater.run(await updater.prepare('1.1.0'));assert.equal((await docker.inspect('xiazai')).Id,'old');assert.equal((await docker.inspect('xiazai')).State.Running,true);
});
