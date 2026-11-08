# xiazai 项目约定

- 独立仓库为 `a06342637/xiazai`，当前目录是独立项目；不要修改外层 xijingzhiwen 项目。
- 服务器数据默认 `/root/xiazai`，通过 bind mount 持久化。不得提交数据、密钥、`.env`、测试产物、`node_modules`。
- 版本号由 `package.json` 管理。发布版本固定 tag；公开版本不覆盖。GitHub Actions 在镜像构建和 Docker smoke 成功后才公开 Release。
- 更新协议保留 app/updater 的容器配置和宿主机数据。更新失败回滚，禁止更新时清空数据。
- 核心改动运行 `npm test`、`npm run build`；界面改动运行 `npm run smoke`。测试使用隔离临时目录。
