import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const image=process.argv[2]; if(!image) throw new Error('Pass Docker image');
const name=`xiazai-disk-smoke-${Date.now()}`;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  // Fill only a disposable container tmpfs, never the runner's or user's system disk.
  docker('run','-d','--name',name,'--tmpfs','/data:size=16m','-p','127.0.0.1::8080','-e','ADMIN_PASSWORD=disk-smoke-password',image);
  const port=JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['8080/tcp'][0].HostPort, base=`http://127.0.0.1:${port}`;
  for(let attempt=0;attempt<40;attempt++){if(JSON.parse(docker('inspect',name))[0].State.Health?.Status==='healthy')break;await sleep(1000);}
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'disk-smoke-password'})});assert.equal(login.status,200);
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0]};
  const capacity=await(await fetch(base+'/api/admin/storage',{headers})).json(); assert.equal(capacity.stats.disk.totalBytes,16*1024**2);
  const small=new FormData();small.append('files',new Blob(['keep this previous file']),'keep.txt');
  const kept=await(await fetch(base+'/api/upload',{method:'POST',headers,body:small})).json(); assert.ok(kept.id);
  const large=new FormData();large.append('files',new Blob([Buffer.alloc(20*1024**2)]),'too-much-for-test-disk.bin');
  const rejected=await fetch(base+'/api/upload',{method:'POST',headers,body:large});assert.equal(rejected.status,507);assert.match((await rejected.json()).error,/95%/);
  const staging=JSON.parse(docker('exec',name,'node','-e','console.log(JSON.stringify(require("fs").readdirSync("/data/.staging")))'));assert.deepEqual(staging,[]);
  const after=await(await fetch(base+'/api/admin/storage',{headers})).json(); assert.equal(after.stats.disk.uploadAllowed,true);assert.equal(after.stats.totalTransfers,1);
  assert.equal(await(await fetch(`${base}/api/transfers/${kept.id}/files/${kept.files[0].id}`)).text(),'keep this previous file');
  const retry=new FormData();retry.append('files',new Blob(['space recovered']),'retry.txt');assert.equal((await fetch(base+'/api/upload',{method:'POST',headers,body:retry})).status,201);
  console.log('Disk Docker smoke passed: real 16 MB filesystem, no file quota, streaming 95% cutoff, cleanup, preserved previous files and resumed upload.');
}catch(error){try{console.error(docker('logs',name));}catch{}throw error;}
finally{try{docker('rm','-f',name);}catch{}}
