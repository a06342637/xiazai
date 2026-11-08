#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
REPO="a06342637/xiazai"
ROOT="${XIAZAI_DATA_DIR:-/root/xiazai}"
DEPLOY="$ROOT/deploy"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

if [[ "$EUID" -ne 0 ]]; then echo "请使用 root 运行：sudo bash install.sh"; exit 1; fi
if [[ ! "$ROOT" =~ ^/[a-zA-Z0-9_/-]+$ || "$ROOT" == "/" ]]; then echo "数据目录必须是安全的绝对路径，不能是根目录。"; exit 1; fi
echo ""
echo "  XIAZAI · 临时下载"
echo "  文件一拖，即刻分享。"
echo ""
if ! command -v curl >/dev/null; then
  if command -v apt-get >/dev/null; then apt-get update -qq; apt-get install -y curl ca-certificates;
  elif command -v dnf >/dev/null; then dnf install -y curl ca-certificates;
  elif command -v yum >/dev/null; then yum install -y curl ca-certificates;
  else echo "请先安装 curl。"; exit 1; fi
fi
if ! command -v docker >/dev/null; then
  echo "正在从 Docker 官方源安装 Docker Engine…"
  curl -fsSL --retry 3 https://get.docker.com -o "$TMP/docker-install.sh"
  sh "$TMP/docker-install.sh"
fi
if ! docker info >/dev/null 2>&1; then
  if command -v systemctl >/dev/null; then systemctl enable --now docker; fi
  docker info >/dev/null
fi
docker compose version >/dev/null || { echo "需要 Docker Compose v2 插件，请安装后重试。"; exit 1; }
mkdir -p "$DEPLOY"
chmod 700 "$ROOT" "$DEPLOY"

echo "正在获取最新正式版本…"
curl -fsSL --retry 3 "https://github.com/$REPO/releases/latest/download/release.json" -o "$TMP/release.json"
# Parse manifest in a tiny Node container; no host Node/Python dependencies are needed.
PARSED="$(docker run --rm -i node:24-alpine node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const m=JSON.parse(s);if(m.schema!==1||!/^\d+\.\d+\.\d+$/.test(m.version)||!/^ghcr\.io\/a06342637\/xiazai@sha256:[a-f0-9]{64}$/.test(m.image))process.exit(1);console.log(m.version);console.log(m.image)})' < "$TMP/release.json")"
VERSION="$(printf '%s\n' "$PARSED" | head -n 1)"
IMAGE="$(printf '%s\n' "$PARSED" | tail -n 1)"
for file in compose.yml reset-admin.sh; do
  curl -fsSL --retry 3 "https://github.com/$REPO/releases/download/v$VERSION/$file" -o "$TMP/$file"
done
cp "$TMP/compose.yml" "$DEPLOY/compose.yml"
cp "$TMP/reset-admin.sh" "$DEPLOY/reset-admin.sh"
chmod 700 "$DEPLOY/reset-admin.sh"

if [[ ! -f "$DEPLOY/.env" ]]; then
  USERNAME="${XIAZAI_ADMIN_USERNAME:-}"
  PASSWORD="${XIAZAI_ADMIN_PASSWORD:-}"
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    if [[ -z "$USERNAME" ]]; then read -r -p "管理员用户名 [回车使用 admin]：" USERNAME < /dev/tty || true; fi
    if [[ -z "$PASSWORD" ]]; then read -r -s -p "管理员密码 [回车随机生成]：" PASSWORD < /dev/tty || true; echo "" > /dev/tty; fi
  fi
  USERNAME="${USERNAME:-admin}"
  if [[ -z "$PASSWORD" ]]; then PASSWORD="$(od -An -N18 -tx1 /dev/urandom | tr -d ' \n')"; fi
  UPDATE_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  PORT="${XIAZAI_PORT:-8080}"
  if [[ ! "$PORT" =~ ^[0-9]+$ || "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then echo "端口无效。"; exit 1; fi
  cat > "$DEPLOY/.env" <<EOF
APP_IMAGE=$IMAGE
UPDATER_IMAGE=$IMAGE
DATA_DIR=$ROOT
PORT=$PORT
PUBLIC_URL=
UPDATE_KEY=$UPDATE_SECRET
EOF
  docker pull "$IMAGE"
  # Password is sent on stdin and never put in command-line arguments or .env.
  printf '%s\0%s' "$USERNAME" "$PASSWORD" | docker run --rm -i "$IMAGE" node -e 'let b=[];process.stdin.on("data",c=>b.push(c));process.stdin.on("end",()=>{const s=Buffer.concat(b).toString().split("\0");process.stdout.write(JSON.stringify({username:s[0],password:s[1]}))})' > "$TMP/admin.json"
  if ! docker compose --project-directory "$DEPLOY" run --rm -T --no-deps app node scripts/bootstrap-admin.mjs < "$TMP/admin.json"; then
    rm -f -- "$DEPLOY/.env"
    echo "账号初始化失败，请检查用户名和密码后重试。"; exit 1
  fi
  printf '用户名：%s\n密码：%s\n' "$USERNAME" "$PASSWORD" > "$DEPLOY/admin-credentials.txt"
  chmod 600 "$DEPLOY/admin-credentials.txt"
else
  echo "检测到已有部署，保留账号、文件、设置和当前镜像版本。"
fi
docker compose --project-directory "$DEPLOY" pull
docker compose --project-directory "$DEPLOY" up -d --wait --wait-timeout 180
echo ""
echo "部署完成 · v$VERSION"
echo "访问：http://服务器IP:${XIAZAI_PORT:-$(sed -n 's/^PORT=//p' "$DEPLOY/.env")}"
if [[ -n "${PASSWORD:-}" ]]; then echo "管理员用户名：$USERNAME"; echo "管理员密码：$PASSWORD"; fi
echo "数据目录：$ROOT"
echo "凭据备份：$DEPLOY/admin-credentials.txt（仅 root 可读）"
echo "重置管理员：bash $DEPLOY/reset-admin.sh"
echo "绑定域名并启用 HTTPS 后，浏览器自动复制链接最稳定。"
