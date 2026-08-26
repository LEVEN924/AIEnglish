# Linux 服务器部署与回滚

目标：`ansible@192.168.1.180`，目录 `/home/ansible/ai-english`；接管 `cayi-ai.top` 原有 AI 助手入口。只停用其原应用容器 `e10-kb-assistant-v1-3-1`，不删除旧代码、数据库、镜像，也不改动 Dify 等无关服务。

## 实际交付状态（2026-08-26）

- 已上传 GitHub `LEVEN924/AIEnglish` main。正在运行的应用代码提交为 `1f44c9ed16972d685ac78a5d3cade37f6da50431`，镜像 `ai-english:1f44c9e`，状态 running / healthy。
- 原应用 `e10-kb-assistant-v1-3-1` 已停止，restart=no；代码、镜像和数据库未删除，其他服务不受影响。
- 原 Nginx 80 / 8443 配置及证书保留，原回环上游 8083 已由 AIEnglish 接管。规范地址为 `https://cayi-ai.top:8443`。内网指向本机时证书验证通过，证书有效至 2026-10-28；不能因此认定公网通畅。
- 数据库完整性 ok，schema 9，1000 篇课程、30,614 条词库、9 个来源词表（包含三本备考词书）。导入种子不含本机用户/录音；配置保留原种子登录账号，注册产生各自独立的新档案。
- 已保存切换前及验收后数据库备份；最近一次为 `backups/ai-english_2026-08-26_07-50-52-984.sqlite`。旧站点配置备份在 `backups/nginx-before-ai-english.conf`。
- 核心自动化测试 **13/13**；服务器两账号收藏隔离、私人录音匿名拒绝、20 并发读取通过。最后一轮并发读取 p50 247 ms、p95 342 ms、最大 365 ms，零失败。验收后容器内存约 119 MiB；不是长时间压力测试。
- Windows Edge 151 全新会话，1440×1000 / 390×844 / 820×1180：注册、收藏提示自动消失、实际腾讯全文播放/暂停、切换词书、查词、刷新不自动背词、课程加载与偏好页全部通过；无横向溢出和控制台错误。使用隔离浏览器会话将域名解析至 192.168.1.180，**未关闭 TLS 验证、未修改电脑 DNS，不代表公网及真机通过**。内置浏览器按正常公网路径报 ERR_CONNECTION_CLOSED，因此使用隔离直连验收区分应用与网络问题。

### 仍需完成的外部条件

1. **P0 / 公网入口：**当前网络实测 443 证书不匹配、8443 连接失败/超时；需核对 DNS、路由器端口映射、防火墙、代理或 NAT 回流，并从真正外网复验。目标映射须指向 `192.168.1.180:8443`，不能继续指向其他 HTTPS 服务。当前未修改路由器。
2. **P0 / 口语评分：**腾讯 SOE-N 返回 4003，账号未开通新版服务。TTS 10/10 和 ASR 已通过，但不能替代 SOE-N 开通及真人录音验收。
3. **P1 / 长录音上传：**现有主机 Nginx 会对约 1.1 MB 请求返回 413。管理员需执行 `sudo bash /home/ansible/ai-english/releases/1f44c9e/deploy/configure-nginx.sh`，允许 16 MiB 上传并重载。当前 SSH 账号没有 Nginx 免密码权限，**该脚本尚未应用**；没有用 Docker 绕过主机权限。

结论：服务器部署和旧系统接管已完成，不能宣称“公网及全部口语功能正式上线通过”。完成以上事项后再复验。

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

仓库提供 `deploy/configure-nginx.sh` 与对应站点配置。管理员可运行 `sudo bash <发布目录>/deploy/configure-nginx.sh`：自动备份、验证、reload，失败恢复旧配置；同时保留公开端口及证书，允许 16 MiB 请求、保留 Host 端口、将 www 入口规范化。应用已按可信代理及 `PUBLIC_ORIGIN` 校验来源，避免旧 Nginx `$host` 丢失端口导致注册/收藏被误拒绝。

域名公网 443/8443 的路由、DNS 和证书应从外部网络复测。页面必须无证书警告，麦克风必须是安全上下文；不要忽略 TLS 错误后宣称录音验收通过。

腾讯说明：[TENCENT_CLOUD_CONFIGURATION.md](./TENCENT_CLOUD_CONFIGURATION.md)。移动端真人录音与公网网络限制不因容器健康而自动消失。
