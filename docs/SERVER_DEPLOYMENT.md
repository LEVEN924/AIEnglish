# Linux 服务器部署与回滚

目标：`ansible@192.168.1.180`，目录 `/home/ansible/ai-english`；接管 `cayi-ai.top` 原有 AI 助手入口。只停用其原应用容器 `e10-kb-assistant-v1-3-1`，不删除旧代码、数据库、镜像，也不改动 Dify 等无关服务。

## 结构

- Nginx 保持现有 80 / 8443 入口及证书；AIEnglish 接管其已有的回环上游 `127.0.0.1:8083`。
- Linux Docker Compose 使用 host 网络，使本机 Nginx 的代理头符合应用仅信任回环来源的安全限制；应用仍只绑定 `127.0.0.1`。
- `runtime.env`：腾讯配置及可选种子账号，权限 600，只读挂载，不进入 Git 或镜像。
- `deployment.env`：版本镜像名、端口、HTTPS origin 等非密钥参数。
- `data/`：持久化 SQLite 与公共语音缓存；`backups/`：数据库及切换记录；目录权限 700。
- 运行容器为非 root，根文件系统只读，限制 1 GiB 内存，日志轮转，重启策略 unless-stopped。

```dotenv
AI_ENGLISH_IMAGE=ai-english:实际已验证的版本标签
PORT=8083
BIND_HOST=127.0.0.1
PUBLIC_ORIGIN=https://cayi-ai.top:8443
TRUST_PROXY=true
COOKIE_SECURE=true
HTTPS_ENABLED=false
```

如果网关将公网 443 映射到服务器 8443，且外部验证成功，再将 `PUBLIC_ORIGIN` 改为 `https://cayi-ai.top` 并重建容器。不要仅凭服务器内网 HTTPS 成功就认定公网 DNS/NAT 正确。

## 首次部署

1. 使用 `deploy/Dockerfile` 从干净代码构建 Linux 镜像。`.dockerignore` 采用允许列表，排除本地配置、数据库与证书。
2. 本机运行 `node scripts/export-deployment-seed.mjs --output=<私有目录>/seed.sqlite`：仅导出共享词库四张表，拒绝覆盖已有文件。通过 SSH 传给服务器，首次初始化为 `data/ai-english.sqlite`。**不要覆盖已存在的服务器数据库。**课程由 `content/lessons.json` 自动初始化。导出不含本机用户、会话、学习记录或录音；如需迁移这些数据，另行评估和备份。
3. 复制 `deploy/compose.yaml` 到部署目录，安全写入 `runtime.env`，设置 `deployment.env`。先用空闲回环端口验证健康、课程/词库、FFmpeg 和真实腾讯语音。
4. 备份原 Nginx 站点配置和旧容器运行信息。新版本验证通过后，给旧容器设置 restart=no 并正常停止，释放 8083；再启动 AIEnglish。
5. 验证域名页面、HTTPS、注册/登录、词库、收藏、文章和单词音频、录音上传限制。保留旧镜像与数据用于回滚。

词库包含用户提供的词书内容，仅安全传到该用户服务器，不作为 SQLite 数据文件公开发布到 GitHub；公开运营前应确认相应内容的使用授权。

## 运维

```bash
cd /home/ansible/ai-english
sudo docker compose --env-file deployment.env ps
sudo docker logs --tail 100 ai-english
sudo docker exec ai-english node scripts/database-maintenance.mjs verify
sudo docker exec ai-english node scripts/database-maintenance.mjs backup
sudo docker exec ai-english node scripts/verify-tencent.mjs --runs=5
```

升级前先数据库备份，使用新的不可混淆镜像标签；不执行 `docker compose down -v`、数据库覆盖或删除旧版本。跨 schema 回滚要同时选择兼容代码及数据库，不能直接让旧代码写新 schema。

## 回到旧系统

确认已保存 AIEnglish 最新数据后：

```bash
cd /home/ansible/ai-english
sudo docker compose --env-file deployment.env stop app
sudo docker update --restart unless-stopped e10-kb-assistant-v1-3-1
sudo docker start e10-kb-assistant-v1-3-1
```

因为复用原 8083 上游，Nginx 无需为此回滚。如果后续修改过站点配置，应由管理员用备份恢复并先 `nginx -t` 再 reload。

## 代理与公网验收

推荐在 Nginx 的该 HTTPS 站点加入 `client_max_body_size 16m;`，保留 `X-Forwarded-Proto $scheme`、`Host $host`，并给音频生成留足至少 120 秒响应时间。改配置需要主机管理员权限，Docker 管理权限不等于已经获得 Nginx 的免密码管理权限。默认 1 MiB 请求体可能拒绝较长录音。

域名公网 443/8443 的路由、DNS 和证书应从外部网络复测。页面必须无证书警告，麦克风必须是安全上下文；不要忽略 TLS 错误后宣称录音验收通过。

腾讯说明：[TENCENT_CLOUD_CONFIGURATION.md](./TENCENT_CLOUD_CONFIGURATION.md)。移动端真人录音与公网网络限制不因容器健康而自动消失。
