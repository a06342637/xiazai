#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(mktemp -d /tmp/xiazai-installer-smoke-XXXXXX)"
PORT=18080
cleanup() {
  if [[ -f "$ROOT/deploy/compose.yml" ]]; then docker compose --project-directory "$ROOT/deploy" down >/dev/null 2>&1 || true; fi
  case "$ROOT" in /tmp/xiazai-installer-smoke-*) rm -rf -- "$ROOT" ;; *) exit 1 ;; esac
}
trap cleanup EXIT
export XIAZAI_DATA_DIR="$ROOT" XIAZAI_PORT="$PORT"
export XIAZAI_ADMIN_USERNAME=installadmin XIAZAI_ADMIN_PASSWORD=isolated-install-password
bash install.sh > "$ROOT/install-output.log" 2>&1 || { sed '/密码/d' "$ROOT/install-output.log"; exit 1; }
printf '\n# preserved custom deployment marker\n' >> "$ROOT/deploy/compose.yml"
before_config="$(sha256sum "$ROOT/deploy/compose.yml" | cut -d ' ' -f 1)"
bash install.sh > "$ROOT/reinstall-output.log" 2>&1 || { sed '/密码/d' "$ROOT/reinstall-output.log"; exit 1; }
test "$before_config" = "$(sha256sum "$ROOT/deploy/compose.yml" | cut -d ' ' -f 1)"
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
const base='http://127.0.0.1:18080';
assert.equal((await fetch(base+'/api/health')).status,200);
const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'installadmin',password:'isolated-install-password'})});
assert.equal(response.status,200);
const cookie=response.headers.get('set-cookie').split(';')[0];
const settings=await fetch(base+'/api/admin/settings',{headers:{Cookie:cookie}}); assert.equal(settings.status,200); assert.equal((await settings.json()).updateEnabled,true);
const data=new FormData(); data.append('files',new Blob(['installer preserved data']),'install.txt');
const uploaded=await fetch(base+'/api/upload',{method:'POST',headers:{Cookie:cookie},body:data}); assert.equal(uploaded.status,201);
const transfer=await uploaded.json();
await import('node:fs/promises').then(fs=>fs.writeFile(process.env.XIAZAI_DATA_DIR+'/test-transfer.json',JSON.stringify(transfer)));
JS
export XIAZAI_ADMIN_PASSWORD=isolated-reset-password
bash "$ROOT/deploy/reset-admin.sh" > "$ROOT/reset-output.log" 2>&1 || { sed '/密码/d' "$ROOT/reset-output.log"; exit 1; }
for attempt in {1..30}; do if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then break; fi; sleep 1; done
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base='http://127.0.0.1:18080';
const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'installadmin',password:'isolated-reset-password'})}); assert.equal(response.status,200);
const transfer=JSON.parse(await readFile(process.env.XIAZAI_DATA_DIR+'/test-transfer.json','utf8'));
assert.equal(await(await fetch(`${base}/api/transfers/${transfer.id}/files/${transfer.files[0].id}`)).text(),'installer preserved data');
JS
echo 'One-click installation and reset scripts passed against the public release image; Docker app/updater, admin login, upload and persistent data verified.'
