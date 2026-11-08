# 临时下载 · XIAZAI

文件一拖，即刻分享。一个可用 Docker 一键部署的临时文件分享站，采用简洁居中布局，支持账号管理、在线预览和管理员在线升级。

当前版本 **v1.0.4**。Linux amd64 / arm64 均可部署。默认文件及设置保存在宿主机 **`/root/xiazai`**。

## 一键部署

在 Linux 服务器上以 root 执行：

```bash
curl -fsSL https://raw.githubusercontent.com/a06342637/xiazai/main/install.sh -o /tmp/xiazai-install.sh && bash /tmp/xiazai-install.sh
```

脚本会安装 Docker（已安装时跳过），读取最新正式 Release 的镜像摘要，提示输入管理员用户名和密码。用户名留空使用 `admin`；密码留空生成随机密码。输入密码不回显；密码不会放入容器环境变量或命令行。初始凭据仅在终端和 root 可读的 `/root/xiazai/deploy/admin-credentials.txt` 中展示。

部署完成访问 `http://服务器IP:8080`，开放服务器 8080 端口。建议通过反向代理绑定 HTTPS 域名，在设置中填写分享域名，确保自动复制链接与视频预览在浏览器中正常使用。

可选部署环境变量：

```bash
XIAZAI_PORT=8090 XIAZAI_DATA_DIR=/root/xiazai bash /tmp/xiazai-install.sh
```

自动化部署可设置 `XIAZAI_ADMIN_USERNAME`、`XIAZAI_ADMIN_PASSWORD`，无需交互。新管理员密码至少 8 个字符。重复执行安装脚本保留已有账号、数据、配置和镜像版本；在线升级请使用设置页面。

## 功能

- 拖拽 / 点击多文件上传，无文件大小、数量和应用总存储额度限制，上传进度、取消上传、完成后自动生成并复制链接。
- 上传前、每块写入前、上传完成前检查磁盘，并每秒巡检正在上传的任务。数据目录所在宿主机文件系统使用率达到 95% 或下一块写入会达到 95% 时立即停止上传，返回提示并清理本次未完成文件；空间释放后可恢复上传。设置页显示磁盘总容量、已用、剩余可用和使用率，每 5 秒刷新。系统和其他程序的占用也计入；默认 `/root/xiazai` 所在系统盘，若改挂载到其他盘则以该数据盘为准。
- 分享页无需登录，支持单文件下载和打包 ZIP 下载；下载按钮后的“直链”可复制直接下载地址，访问即下载原文件，使用相同到期规则。上传完成和分享页面以列表展示多个文件，点击文件行展开图片、视频、音频、PDF、文本预览或 ZIP 操作。
- 默认选择 1 天（24 小时），可以选择“永久”保留。永久分享持续有效，不参与过期清理，登录用户可手动删除自己的文件。每 24 小时清理过期文件，管理员可修改保留时间与清理周期，也能立即清理已过期文件；重启时补做清理。
- 右上角登录 / 注册。注册账号是普通用户，登录后上传自动归属本人；我的文件支持历史查看、复制、预览、删除。匿名上传不归属账号。
- 管理员独占站点设置、空间统计、清理和在线升级权限。普通用户无法通过接口提升角色或管理其他用户文件。
- 图片（JPEG/PNG/GIF/WebP/AVIF）、视频（MP4/WebM/MOV）、音频、PDF、文本及代码预览。实际媒体播放取决于浏览器编解码支持；Office 文件可下载查看。
- ZIP 在线目录查看、内部文件预览与独立下载。传统 ZipCrypto 和 AES 加密 ZIP 支持输入密码解锁，密码错误可重试；解锁校验解密内容和 CRC / AES 认证。密码通过请求正文提交，仅在服务器短期内存使用，解锁令牌限定单个压缩包、最长 30 分钟且不超过分享有效期，密码和令牌不放入下载 URL。关闭预览后清除浏览器令牌。服务不将解压内容落盘；禁止路径穿越和过高压缩率，限制 2000 项、总解压 500 MB、单个文件 100 MB。文本预览最多 2 MB；解压任务最长 30 秒。
- 明暗主题、手机布局、中文界面。桌面首页按窗口高度适配，上传卡片、功能说明和页脚完整显示；手机与长文件列表仍可滚动。
- 设置显示当前版本、检查新版本、一键升级、进度和结果。更新使用正式 Release 中的 SHA-256 镜像摘要，保留挂载 / 端口 / 网络 / 配置，健康检查失败自动回滚。

已有文件的到期时间不会随着保留设置变更；未到期文件不会被“立即清理”删除。过期后登录用户可看到待清理记录；清理或手动删除后该记录从历史中移除。正在下载 / 预览的文件会等待当前请求完成再清理。

## 管理员密码重置

登录后在右上角账号窗口修改密码，修改后所有该账号会话失效。忘记密码时在服务器执行：

```bash
bash /root/xiazai/deploy/reset-admin.sh
```

重新输入用户名、新密码，留空使用 `admin` 和随机密码。脚本短暂停止应用后离线修改账号库，再启动原镜像；用户文件和普通用户不受影响。管理员用户名可一起变更。

## 在线升级和发布

管理员登录 → 设置 → 检查更新 → 一键升级。应用容器没有 Docker Socket，独立 updater 服务通过内部网络接收验证请求；updater 不向宿主机开放端口。Docker Socket 只挂载到 updater，因此 updater 属于高权限部署组件。不要把 updater 接口代理到公网。

升级步骤：读取已公开的正式 GitHub Release → 验证清单 → 按 digest 拉取镜像 → 预创建新容器 → 停止并保留旧容器 → 启动新版 → 健康检查 → 成功后持久化镜像版本并清理旧容器；失败自动恢复旧容器。此过程中 `/root/xiazai` 始终保持持久化。更高版本应保持数据格式向后兼容。

一键部署的 `.env` 会保存升级后的 `APP_IMAGE`，后续 Compose 重启不会退回旧版本。updater 使用独立的 `UPDATER_IMAGE` 和 schema 1 更新协议；业务版本升级时保持该服务运行。升级 updater 协议时在服务器明确更新 `UPDATER_IMAGE` 后运行 Compose。

发布新版本：同步 `package.json`、`package-lock.json`、`compose.yml` 和 `.env.example` 中的版本；运行测试和构建；提交并推送 `vX.Y.Z` tag。GitHub Actions 先创建草稿 Release，完成测试、浏览器 smoke、Docker 上传及容器 smoke，再完整上传 `release.json`、安装脚本、Compose 文件后公开。固定版本不覆盖。

## 手动 Docker 部署

```bash
git clone https://github.com/a06342637/xiazai.git
cd xiazai
cp .env.example .env
# 编辑 .env：设置 ADMIN_USERNAME、ADMIN_PASSWORD 和随机 UPDATE_KEY
docker compose up -d --wait
```

手动部署在首次启动创建管理员账号；之后以账号库为准。在线升级能替换运行容器；手动部署的外部 `.env` 不在数据挂载内，需要同步更新其 `APP_IMAGE` 才能用 Compose 重新创建新版容器。推荐使用一键脚本的 `/root/xiazai/deploy` 配置。

## 数据和反向代理

```text
/root/xiazai/
├── uploads/<随机ID>/   # 文件和分享元信息
├── accounts.json      # scrypt 密码摘要和哈希会话令牌
├── settings.json      # 网站设置
├── system.json        # 清理执行时间
├── system/update.json # 持久化升级状态
└── deploy/            # Compose、环境配置、重置脚本和初始凭据
```

备份时短暂停止 app 再备份整个目录，恢复时使用备份版本镜像与相同目录。禁止在更新时删除数据挂载。

Nginx 示例（需先配置域名的 HTTPS 证书）：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

代理需要保留 Host；Nginx 使用 `client_max_body_size 0` 取消代理大小限制，并禁用请求缓冲，避免大文件先占用代理临时目录。已有反向代理的限制需要在代理中同步调整。设置分享域名为 `https://你的域名` 后 Cookie 启用 Secure。站点不提供 Wormhole 的端到端加密或 P2P 传输：文件存储在你的服务器，知道分享链接的人可查看下载。

## 本地开发与验证

```bash
npm ci
ADMIN_USERNAME=admin ADMIN_PASSWORD='a-long-development-password' npm start
npm test
npm run build
npx playwright install chromium
npm run smoke
```

Windows PowerShell：

```powershell
$env:ADMIN_USERNAME='admin'
$env:ADMIN_PASSWORD='a-long-development-password'
npm start
```

测试和 smoke 自动使用操作系统临时目录，不操作用户文件。正式镜像只包含运行依赖；UI 不依赖外部 CDN。
