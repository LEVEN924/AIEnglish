# Linux 服务器部署与回滚

目标：`ansible@192.168.1.180`，目录 `/home/ansible/ai-english`；接管 `cayi-ai.top` 原有 AI 助手入口。只停用其原应用容器 `e10-kb-assistant-v1-3-1`，不删除旧代码、数据库、镜像，也不改动 Dify 等无关服务。

## 实际交付状态（2026-08-26）

- GitHub 仓库为 `LEVEN924/AIEnglish`。正在运行的应用代码提交为 `7d176ea7a18b82e70f80c5bb3ea5ac0a734bb862`，镜像 `ai-english:7d176ea`，状态 running / healthy；保留 `512561c` 的 Linux 部署文件 LF 换行规则。
- 原应用 `e10-kb-assistant-v1-3-1` 已停止，restart=no；代码、镜像和数据库未删除，其他服务不受影响。
- 正确公网入口为 **`https://cayi-ai.top:20057`**。用户确认、实际访问验证的映射为 `112.12.19.230:20057 → 192.168.1.180:8443 → 127.0.0.1:8083`；Nginx 仍监听本机 80 / 8443，保留现有证书，有效至 2026-10-28。不要把公网端口误写为 8443 或 443。
- 数据库完整性 ok，schema 9，1000 篇课程、30,614 条词库、9 个来源词表（包含三本备考词书）。导入种子不含本机用户/录音；配置保留原种子登录账号，注册产生各自独立的新档案。
- 已保存切换前及验收后数据库备份；本次更新前备份为 `backups/ai-english_2026-08-26_09-07-52-417.sqlite`，更新前环境配置为 `backups/deployment-before-7d176ea.env`，可回退至 `ai-english:8faf429` 而无需改数据库。Nginx 修改前备份为 `/etc/nginx/ai-english-backup.qQlwgRTP/cayi-ai.top`；最初站点备份仍在 `backups/nginx-before-ai-english.conf`。
- 核心自动化测试 **28/28**，含旧浏览器请求兼容、账号切换/超时取消、录音模式及多用户评测并发限制；构建通过。先前服务器两账号收藏隔离、私人录音匿名拒绝、20 并发读取通过，p50 247 ms、p95 342 ms、最大 365 ms，零失败。本轮本地 8 用户、40 次并发读取零失败，p95 200 ms；不同环境指标不可直接比较。新版本公网三轮评分后检查内存约 146 MiB，数据库完整性 ok，不是长时间压力测试。
- 首次部署、尚未确认公网 20057 映射时，Windows Edge 151 全新会话，1440×1000 / 390×844 / 820×1180：注册、收藏提示自动消失、实际腾讯全文播放/暂停、切换词书、查词、刷新不自动背词、课程加载与偏好页全部通过；无横向溢出和控制台错误。当时使用隔离浏览器会话将域名解析至 192.168.1.180，**未关闭 TLS 验证、未修改电脑 DNS，该轮只证明内网及模拟视口通过**。当时测试错误公网端口出现的 ERR_CONNECTION_CLOSED，不应继续作为正确 20057 入口的故障结论；本轮正常公网浏览器验证见下文。

### 本次公网与录音修复结果

1. **已修复 / 公网来源校验：**DNS A 记录和服务器公网出口均为 `112.12.19.230`。20057 的 HTTPS 页面与证书原本正常，但应用配置错误地使用 `PUBLIC_ORIGIN=https://cayi-ai.top:8443`，从实际公网端口提交会得到 403“请求来源不受信任”。现已改为 20057，注册、登录、收藏、保存学习状态均通过。之前 443 返回 `ai.cayi.pro` 证书、公网 8443 超时，不适用于本系统真实入口；没有改动这些端口或路由器映射。
2. **已验证 / 口语评分：**用户开通后 ASR / SOE-N 三轮均成功，SOE-N 真实评分字段已校验；另完成一段 64.296 秒合成音频的公网上传、腾讯评分及逐字节一致回听，仅写入专用测试账号。详见腾讯配置说明。
3. **已修复 / 长录音上传：**用户在独立 SSH 窗口输入 sudo 密码后，Nginx 配置已备份、检查并成功重载。上传上限 16 MiB、上游评分响应等待 360 秒、客户端评分等待 420 秒。约 1.1 MB、4 MiB、12.8 MB 的有效 JSON 请求均到达应用（故意使用不存在课程，返回预期 404，无录音保存），17 MiB 请求返回预期 413；真实长音频 API 请求 2.74 MB 返回 200。系统仍限制录音最长 5 分钟。
4. **已修复 / 部署脚本兼容性：**第一次管理员执行因 Windows 导出 CRLF 在 `set -euo pipefail` 行失败，未改动 Nginx。重新上传 LF 原文件后成功执行；`.gitattributes` 强制 Linux 部署文件使用 LF，并实际检查了 Git 导出的归档内容。
5. **公网浏览器验收：**Windows 内置浏览器，1280×720，全新测试账号，通过正常 `https://cayi-ai.top:20057` 注册 → 今日页 → 收藏 → 提示消失 → 腾讯文章完整播放（64.296 秒）→ 单词发音 → 刷新保留会话与收藏。页面身份正确、非空、无框架错误覆盖、控制台无警告/错误、无横向溢出，已有截图证据；未替换 DNS、未关闭 TLS 验证。
6. **已修复并部署 / 手机登录兼容：**故障时段日志中 Android 的 Chrome 91 与 Chrome 115/HeyTap 内核已取得页面和脚本，但未发出 session/login 请求。前端直接调用缺失的 `AbortSignal.any()`，其 TypeError 被误报成网络失败；同时移除了对 `AbortSignal.timeout()`、实例 `throwIfAborted()` 与数组 `.at()` 的依赖，生产语法目标降至 Chrome/Edge 91、Firefox 91、Safari 15。使用 AbortController、定时器和可清理监听器兼容实现，并保持请求直到响应体读取完毕均受超时/账号取消保护。Chrome 116 才增加 `any()`，Safari 17.4 才支持：[Chrome 官方说明](https://developer.chrome.com/blog/chrome-116-beta?hl=en)、[WebKit 官方说明](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/)。兼容回归模拟缺失 API，不等同实际老版安卓/iOS 真机验收。
7. **已修复并部署 / 腾讯评分慢：**原实现以实时模式每 40 ms 发送 1280 字节，把已完成录音按原速重发。现改腾讯官方录音模式，每段一次上传且不超过 60 秒，共享有界并发；不降低成人严格评分标准。相同 64.296 秒样本候选容器三轮 15.0–15.6 秒；线上公网上传评分三轮 **15.700 / 16.742 / 16.483 秒**，对比原 37.118 秒，中位数耗时减少约 **56%**。全部返回真实腾讯声学评分，上次录音均逐字节回听一致。新版本公网登录 API 126 ms；Windows 浏览器已实际退出 → 重新登录 → 腾讯文章播放（进度至 36 秒）→ 暂停 → 单词发音，页面加载新脚本 `index-k6SuqIRg.js`，无控制台警告/错误、无横向溢出。证据截图保存在本次本地验收产物中，不含真实用户隐私。

结论：“公网端口/403、腾讯服务未开通、Nginx 长录音 413”已解决并复验，新增的旧手机登录兼容与评分耗时修复也已上线。仍需用户关闭旧页面、重新访问 `https://cayi-ai.top:20057` 后，以手机 Wi-Fi/蜂窝网络及真实麦克风复验，尤其是 iOS/Safari、平板权限和完整 5 分钟真人录音；当前证据不能替代所有真机、所有运营商的上线验收。不要为刷新旧脚本直接清空未同步的学习草稿。

## 结构

- Nginx 保持本机 80 / 8443 监听及证书；公网 NAT 20057 转入 8443，AIEnglish 接管回环上游 `127.0.0.1:8083`。HTTP / www 跳转均保留正确的公网 20057 端口。
- Linux Docker Compose 使用 host 网络，使本机 Nginx 的代理头符合应用仅信任回环来源的安全限制；应用仍只绑定 `127.0.0.1`。
- `runtime.env`：腾讯配置及可选种子账号，权限 600，只读挂载，不进入 Git 或镜像。
- `deployment.env`：版本镜像名、端口、HTTPS origin 等非密钥参数。
- `data/`：持久化 SQLite 与公共语音缓存；`backups/`：数据库及切换记录；目录权限 700。
- 运行容器为非 root，根文件系统只读，限制 1 GiB 内存，日志轮转，重启策略 unless-stopped。

```dotenv
AI_ENGLISH_IMAGE=ai-english:实际已验证的版本标签
PORT=8083
BIND_HOST=127.0.0.1
PUBLIC_ORIGIN=https://cayi-ai.top:20057
TRUST_PROXY=true
COOKIE_SECURE=true
HTTPS_ENABLED=false
```

`PUBLIC_ORIGIN` 描述浏览器访问的外部地址，而不是 Nginx 监听端口。现有映射公网 20057 → 内网 8443 无需修改。将来若改用 443，须先验证新的网关路由和证书，再同步修改应用 origin、Nginx 跳转地址，并重建容器；不要只改其中一处。

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

本次已在该 HTTPS 站点应用 `client_max_body_size 16m;`、`proxy_read_timeout 360s;`，保留 `X-Forwarded-Proto $scheme` 并使用 `Host $http_host` 传递端口。改配置需要主机管理员权限，Docker 管理权限不等于 Nginx 的免密码管理权限。默认 1 MiB 请求体会拒绝较长录音，Base64 JSON 还会增加约三分之一传输体积。

仓库提供 `deploy/configure-nginx.sh` 与对应站点配置。本次已成功执行 `sudo bash /home/ansible/ai-english/releases/8faf429/deploy/configure-nginx.sh`：自动备份、验证、reload，失败恢复旧配置；保留证书、允许 16 MiB 请求、保留 Host 端口，将 HTTP / www 规范化至公网 20057。必须传输 LF 格式脚本，并在执行前做 `file` 与 `bash -n` 检查。应用仍按可信代理及精确 `PUBLIC_ORIGIN` 校验来源，没有放开任意跨域。

公网复测必须访问 `https://cayi-ai.top:20057`，而不是 `https://112.12.19.230:20057`（证书签给域名），也不是公网 8443 或未带端口的 443。页面必须无证书警告，麦克风必须是安全上下文；不要忽略 TLS 错误后宣称录音验收通过。

腾讯说明：[TENCENT_CLOUD_CONFIGURATION.md](./TENCENT_CLOUD_CONFIGURATION.md)。移动端真人录音与公网网络限制不因容器健康而自动消失。
