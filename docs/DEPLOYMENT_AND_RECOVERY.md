# AIEnglish 部署、验证与恢复

适用版本：2026-08-26，SQLite schema 9。这里区分本机/局域网试用与公开上线；本地 CA 不能替代公网可信证书。

## 1. 当前本机与局域网

- 电脑入口：`https://127.0.0.1:4174/`。一键启动在当前 Windows 用户信任本地 CA 后优先打开 HTTPS。
- 局域网地址由一键启动脚本显示，不要固定使用旧 IP。2026-08-26 检查时为 `https://192.168.150.122:4174/`。
- 局域网 HTTP 入口会重定向至 HTTPS；电脑回环 HTTP 仅为本地开发/诊断保留。
- 启动前会检查证书有效期和当前网卡 IP；需要更新时保留旧叶证书/私钥副本。不会自动安装受信任根证书。
- 仅将 `.runtime/https/local-root-ca.crt` 安装到你信任的测试设备。**不要分发 root-ca-key.pem、server-key.pem 或任何私钥。**每台手机、平板均须自行完成信任和录音权限确认。
- 不能通过“忽略证书错误”的测试认定麦克风功能通过。

```powershell
npm run https:setup
# 仅检查，不改证书：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-https.ps1 -CheckOnly
# 由设备所有者确认后，仅信任到当前 Windows 用户：
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local-https.ps1 -InstallTrust
```

## 2. 公开上线配置

准备你控制的域名、DNS、可访问的主机以及可信 TLS 证书。仓库提供 `deploy/Caddyfile.example` 与 `deploy/production.env.example`，尚未对任何公网域名发布。

将示例域名替换为真实域名；将环境变量放入部署环境或 `.env.local`，不要提交腾讯密钥：

```text
PUBLIC_ORIGIN=https://你的真实域名
TRUST_PROXY=true
BIND_HOST=127.0.0.1
COOKIE_SECURE=true
HTTPS_ENABLED=false
PORT=4173
```

同机反向代理终止 TLS 并转发到 `127.0.0.1:4173`；应用只信任来自回环地址的 `X-Forwarded-Proto: https`。跨主机代理不能直接照搬这个设置。未受信任来源伪造该头不会启用安全会话。

公开域名模式强制使用规范 HTTPS 地址，Cookie 带 `Secure; HttpOnly; SameSite=Lax`，HTTPS 响应启用 HSTS。不要将后端 4173 端口直接暴露到公网。

`GET /api/health` 检查进程与数据库版本；`GET /api/ready` 检查数据库、构建文件、腾讯配置及规范 HTTPS origin。当前没有设置公网 origin，因此本机 `/api/ready` 返回 503 是预期发布门禁，不表示本地学习失效。配置检查不等于腾讯服务实时可用，仍须运行真实调用验证。

## 3. 发布门禁

```powershell
npm run build
npm test
npm run test:ui
npm run test:release
npm run content:validate
npm run content:audit-words
npm run db:verify
npm run tencent:verify -- --runs=5
```

`test:release` 默认用已安装的 Windows Edge，独立临时数据库与新浏览器上下文，不复用学习者缓存。测试证据保留在系统临时目录，设置 `QA_OUTPUT` 可指定已存在的输出目录。

指定其他已安装的测试引擎：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='已安装测试浏览器的目录'
$env:QA_BROWSER='firefox' # 也可 chrome / webkit / edge
npm run test:release
$env:AI_ENGLISH_TEST_USERS='20'
node --test tests/multi-user.test.mjs
```

测试不会自动下载浏览器。Windows WebKit 的音频解码失败不能等同于真实 Safari 失败或通过。必须在真实 Android Chrome、iOS/iPadOS Safari 上补测：注册/登录、拒绝与重新授权麦克风、录音前停止听力、口语提交、回听上一次录音、离开页面停止麦克风、前后台切换、竖横屏、弱网与换账号。

上线前在目标站点确认：无证书警告；安全上下文与麦克风接口可用；登录 Cookie 含 Secure；私人录音响应 no-store；匿名请求录音 401；B 用户不能读取 A 的录音；退出后缓存没有录音；两道译写难度相近且内容不同；`mini` 不能当作 `minutes` 判对。

## 4. 数据备份与恢复

普通备份不再删除任何旧备份。仅显式传入 `--prune` 才按保留策略清理工具命名的备份；不要把别的 SQLite 文件当备份清理。

数据库备份包含学习数据及可能的私人录音，应保存在受控目录，不要公开分享。旧版无账号归属的浏览器草稿只隔离保留，不自动分配给登录者；确认原所有者后再人工恢复。旧 SW 录音副本会清理，服务端原录音保留。

```powershell
npm run db:backup
# 建议先恢复到全新文件，验证后再决定是否切换；原数据库不受影响。
npm run db:restore -- --from backups/实际备份名.sqlite --database data/restore-verified.sqlite
npm run db:verify -- --database data/restore-verified.sqlite
```

已有目标文件默认拒绝覆盖。需要替换时必须停止使用目标库的服务，并显式使用 `--replace`；工具会先保存 `.before-restore-*` 安全副本。存在 WAL/SHM 时会拒绝替换，而不是删除日志。Windows 强制停止后可能仍有 WAL 文件；不要手工删除它们，应优先采用恢复到全新文件的方案，并经验证后配置 `AI_ENGLISH_DB_PATH` 指向该文件。对非默认数据库，备份也要显式传入相同 `--database`。

本轮已完成独立恢复演练：`D:/PG_Temp/ai-english-pre-optimization-20260826.sqlite` → `D:/PG_Temp/ai-english-restore-rehearsal-20260826.sqlite`，完整性 ok、schema 9、1000 篇课程。没有用演练文件覆盖正式数据。

代码回滚应使用已验证的上一版发布包，同时保留版本化静态资源供仍打开旧页面的用户读取；不要对本工作区执行硬重置。回滚数据库前先保留当前数据和对应应用版本。上线后关注 `.runtime/server.err.log` 的 requestId、状态码与耗时；日志不记录 Cookie、密钥、用户答案或录音。
