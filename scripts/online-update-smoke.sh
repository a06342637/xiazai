#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(mktemp -d /tmp/xiazai-online-upgrade-XXXXXX)"
cleanup() {
  if [[ -f "$ROOT/deploy/compose.yml" ]]; then docker compose --project-directory "$ROOT/deploy" down >/dev/null 2>&1 || true; fi
  case "$ROOT" in /tmp/xiazai-online-upgrade-*) rm -rf -- "$ROOT" ;; *) exit 1 ;; esac
}
trap cleanup EXIT
export XIAZAI_DATA_DIR="$ROOT" XIAZAI_PORT=18080 XIAZAI_ADMIN_USERNAME=updateadmin XIAZAI_ADMIN_PASSWORD=isolated-online-update-password
bash install.sh > "$ROOT/install.log" 2>&1 || { sed '/密码/d' "$ROOT/install.log"; exit 1; }
# Stage the previous public app version, retaining the installed updater and all data.
sed -i -e 's|^APP_IMAGE=.*|APP_IMAGE=ghcr.io/a06342637/xiazai:1.0.5|' -e 's|^UPDATER_IMAGE=.*|UPDATER_IMAGE=ghcr.io/a06342637/xiazai:1.0.5|' "$ROOT/deploy/.env"
docker compose --project-directory "$ROOT/deploy" up -d --wait --wait-timeout 180
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base='http://127.0.0.1:18080';
const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'updateadmin',password:'isolated-online-update-password'})}); assert.equal(login.status,200);
const cookie=login.headers.get('set-cookie').split(';')[0], headers={Cookie:cookie};
assert.equal((await(await fetch(base+'/api/health')).json()).version,'1.0.5');
const form=new FormData(); form.append('files',new Blob(['real online upgrade retained this file']),'upgrade.txt');
const upload=await fetch(base+'/api/upload',{method:'POST',headers,body:form}); assert.equal(upload.status,201); const transfer=await upload.json();
const check=await fetch(base+'/api/admin/version',{headers}); assert.equal(check.status,200); const release=await check.json(); assert.equal(release.available,true); assert.equal(release.latest,'1.0.6');
const update=await fetch(base+'/api/admin/update',{method:'POST',headers}); const state=await update.json(); assert.equal(update.status,202,JSON.stringify(state)); assert.equal(state.targetVersion,'1.0.6');
let complete=false;
for(let attempt=0;attempt<100;attempt++) {
  await new Promise(resolve=>setTimeout(resolve,3000));
  try {
    const status=await(await fetch(base+'/api/admin/update',{headers})).json();
    if(['failed','rolled_back'].includes(status.phase)) throw new Error(JSON.stringify(status));
    if(status.phase==='success') {complete=true;break;}
  } catch(error) {if(error.message.includes('"phase"'))throw error;}
}
assert.ok(complete,'Online upgrade must finish');
assert.equal((await(await fetch(base+'/api/health')).json()).version,'1.0.6');
assert.equal(await(await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`)).text(),'real online upgrade retained this file');
assert.equal((await fetch(base+'/api/history',{headers})).status,200);
const storage=await(await fetch(base+'/api/admin/storage',{headers})).json();assert.ok(storage.stats.disk.availableBytes>0);
const files=new FormData();for(let i=0;i<101;i++)files.append('files',new Blob(['no count limit']),`file-${i}.txt`);assert.equal((await fetch(base+'/api/upload',{method:'POST',headers,body:files})).status,201);
assert.match(await readFile(process.env.XIAZAI_DATA_DIR+'/deploy/.env','utf8'),/^APP_IMAGE=ghcr\.io\/a06342637\/xiazai@sha256:/m);
console.log('Production online upgrade passed: admin version check, official release digest pull, v1.0.5 → v1.0.6, progress, persisted digest, retained accounts/sessions/files.');
JS
