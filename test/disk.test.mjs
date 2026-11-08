import test from 'node:test';
import assert from 'node:assert/strict';
import { DiskGuard } from '../server/disk.mjs';

test('concurrent writes cannot reuse the same remaining disk budget or cross 95%',async()=>{
  let free=60, writes=0;
  const disk=new DiskGuard('/data',async()=>({bsize:1,blocks:1000,bfree:free,bavail:free}));
  const results=await Promise.allSettled([6,6].map(size=>disk.write(size,async()=>{await new Promise(r=>setTimeout(r,10));free-=size;writes++;})));
  assert.equal(writes,1); assert.equal(results.filter(r=>r.status==='rejected').length,1); assert.equal(free,54);
});

test('filesystem reserved space does not count as used; bavail still limits writable space',async()=>{
  const disk=new DiskGuard('/data',async()=>({bsize:1,blocks:1000,bfree:100,bavail:50}));
  const info=await disk.info(); assert.equal(info.usedPercent,90); assert.equal(info.availableBytes,50);
  await disk.check(49); await assert.rejects(disk.check(50),{status:507});
});

test('failed disk probes fail closed; idle active uploads are aborted when disk becomes full',async()=>{
  let free=500;
  const disk=new DiskGuard('/data',async()=>({bsize:1,blocks:1000,bfree:free,bavail:free}));
  const controller=new AbortController(), unwatch=disk.watch(controller);
  try {
    free=50;
    await new Promise(resolve=>{controller.signal.addEventListener('abort',resolve,{once:true});setTimeout(resolve,1600);});
    assert.ok(controller.signal.aborted); assert.equal(controller.signal.reason.status,507);
  } finally { unwatch(); }
  disk.probe=async()=>{throw new Error('unavailable');};
  await assert.rejects(disk.write(1,async()=>assert.fail('must not write')),{status:503});
});
