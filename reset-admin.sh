#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="${XIAZAI_DATA_DIR:-/root/xiazai}"
DEPLOY="$ROOT/deploy"
if [[ "$EUID" -ne 0 ]]; then echo "请使用 root 运行。"; exit 1; fi
if [[ ! "$ROOT" =~ ^/[a-zA-Z0-9_/-]+$ || "$ROOT" == "/" ]]; then echo "数据目录必须是安全的绝对路径，不能是根目录。"; exit 1; fi
if [[ ! -f "$DEPLOY/.env" ]]; then echo "未找到部署配置：$DEPLOY/.env"; exit 1; fi
USERNAME="${XIAZAI_ADMIN_USERNAME:-}"
PASSWORD="${XIAZAI_ADMIN_PASSWORD:-}"
if ( : < /dev/tty ) 2>/dev/null; then
  if [[ -z "$USERNAME" ]]; then read -r -p "管理员用户名 [回车使用 admin]：" USERNAME < /dev/tty || true; fi
  if [[ -z "$PASSWORD" ]]; then read -r -s -p "新的管理员密码 [回车随机生成]：" PASSWORD < /dev/tty || true; echo "" > /dev/tty; fi
fi
USERNAME="${USERNAME:-admin}"
PASSWORD="${PASSWORD:-$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')}"
TMP="$(mktemp -d)"
NEED_START=0
cleanup() { rm -rf -- "$TMP"; if [[ "$NEED_START" == 1 ]]; then docker start xiazai >/dev/null; fi; }
trap cleanup EXIT
# Always use the running app's exact image, including after an online upgrade.
IMAGE="$(docker inspect --format '{{.Config.Image}}' xiazai)"
ACTUAL_ROOT="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' xiazai)"
if [[ "$ACTUAL_ROOT" != "$ROOT" ]]; then echo "数据目录与运行容器不一致，请指定正确 XIAZAI_DATA_DIR 后重试。"; exit 1; fi
if [[ -f "$ROOT/system/update.json" ]]; then
  docker run --rm -v "$ROOT:/data:ro" "$IMAGE" node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync("/data/system/update.json"));if(!["idle","success","failed","rolled_back"].includes(s.phase)){console.error("系统正在更新，请更新结束后重置密码。");process.exit(1)}'
fi
printf '%s\0%s' "$USERNAME" "$PASSWORD" | docker run --rm -i "$IMAGE" node -e 'let b=[];process.stdin.on("data",c=>b.push(c));process.stdin.on("end",()=>{const s=Buffer.concat(b).toString().split("\0");process.stdout.write(JSON.stringify({username:s[0],password:s[1],reset:true}))})' > "$TMP/admin.json"
docker stop --time 35 xiazai >/dev/null
NEED_START=1
docker run --rm -i -v "$ROOT:/data" -e DATA_DIR=/data "$IMAGE" node scripts/bootstrap-admin.mjs < "$TMP/admin.json"
printf '用户名：%s\n密码：%s\n' "$USERNAME" "$PASSWORD" > "$DEPLOY/admin-credentials.txt"
chmod 600 "$DEPLOY/admin-credentials.txt"
echo "管理员用户名：$USERNAME"
echo "管理员新密码：$PASSWORD"
echo "所有旧管理员登录会话已失效，文件和普通账号保持完整。"
