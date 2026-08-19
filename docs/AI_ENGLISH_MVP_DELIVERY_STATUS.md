# AIEnglish 1.0 交付与运行手册

> 更新时间：2026-08-19<br>
> 当前版本：1.0.0<br>
> 产品基线：[AI_ENGLISH_APP_PRODUCT_UI_PLAN.md](./AI_ENGLISH_APP_PRODUCT_UI_PLAN.md)

## 1. 交付结论

AIEnglish 1.0 已按照产品与 UI 方案完成连续开发并实际运行。系统采用“档案馆编辑”视觉风格，“今日学习”标题下方固定展示导读、听力、翻译、口语、写作、总结六步进度；用户可跳过本篇或从 1000 篇内容库打开任意课程。

内容、账号、会话、学习状态、作答版本、评分、错题、生词、复习尝试和周报数据均持久化到 SQLite。电脑和同一 Wi-Fi 下的手机访问同一服务，学习数据实时共享。

当前访问地址：

- 电脑 HTTP：`http://127.0.0.1:4173/`
- 电脑 HTTPS：`https://127.0.0.1:4174/`
- 手机：以一键启动窗口实时显示的局域网地址为准
- 登录用户：`LEVEN`
- 密码只保存在本机环境的单向哈希配置中，不写入代码、文档或 Git

## 2. 任务目标与完成情况

| 目标 | 状态 | 实际结果 |
| --- | --- | --- |
| 按既定产品方案完成 1.0 | 完成 | 档案馆 UI、六步学习、内容档案、复盘簿和个人档案均已落地 |
| 内容扩充并存入数据库 | 完成 | 1000 篇、1000 个唯一来源；L1/L2/L3 为 350/400/250 |
| 内容质量流水线 | 完成 | 1000/1000 通过字段、长度、去重、来源和分级校验 |
| 跨电脑/手机保存进度 | 完成 | 服务端 SQLite 为运行时主库，不依赖浏览器 localStorage |
| 真实作答与反馈 | 完成 | 每次提交保存版本、分项量表、评分器与改进建议 |
| AI 能力与稳定降级 | 完成代码；待密钥实调 | 默认 DeepSeek V4 Flash JSON 批改；浏览器转写/TTS 和本地量表作为降级 |
| 复习闭环 | 完成 | 低分生成错题，主动回忆后按 1/3/7 天推进，3 次掌握归档 |
| 生词与周报 | 完成 | 课程词汇一键收藏；七日课程/复习统计写入并读取数据库 |
| 安全与运维 | 完成 | 登录限速、同源校验、CSP、HttpOnly 会话、迁移、完整性检查、备份恢复 |
| 局域网 HTTPS | 完成服务与证书 | 已生成本地 CA 和服务证书；手机需手动信任本地 CA |
| 桌面/手机验证 | 完成 | API、构建、Edge/Playwright 桌面及 390px 手机视口全部通过 |

## 3. 内容库

- `content/lessons.json`：1000 篇可审查内容基线，catalog version 3。
- 原有 50 篇权威机构课程继续保留；新增 950 篇来自英文 Wikipedia Level 4 Vital Articles 的 11 个主题分类。
- 每篇正文 120–179 词，包含中英文标题、中文导读、核心观点、翻译/口语/写作任务、至少 3 个重点词、来源和质量评分。
- 采集器具有重试、限速、持久缓存、URL/正文去重、分级排序和固定配额功能。
- `content/crawl-report.json`：批次、分类、难度和字数统计。
- `content/ingestion-report.json`：逐篇校验、来源检查和错误列表。

常用命令：

```powershell
npm run content:generate
npm run content:validate
npm run content:refresh
```

## 4. 数据保存位置

运行主库：

```text
C:\Users\张作明\Documents\AiEnglish\data\ai-english.sqlite
```

自动备份：

```text
C:\Users\张作明\Documents\AiEnglish\backups\
```

运行日志、PID、联网采集缓存和本地 HTTPS 私钥：

```text
C:\Users\张作明\Documents\AiEnglish\.runtime\
```

主要数据表包括：

- 内容：`content_sources`、`source_articles`、`lesson_segments`、`lesson_sentences`、`lesson_vocabulary`
- 学习：`learning_profiles`、`lesson_progress`、`conversations`、`daily_summaries`
- 作答：`submissions`、`grading_results`、`pronunciation_assessments`
- 复习：`error_items`、`review_tasks`、`review_attempts`、`vocabulary_book`
- 运维：`schema_migrations`、`learning_state_revisions`、`source_health_checks`、`audit_log`

私人数据库、备份、`.env.local`、运行缓存和证书私钥均被 `.gitignore` 排除。内容 JSON、迁移代码和测试可以进入 Git。

## 5. 学习与 AI 能力

### 默认可用

- 浏览器美式英文朗读、三档语速、逐句控制。
- 翻译、写作和口述文本的可解释本地量表评分。
- 录音、本机回听；支持浏览器 Speech Recognition 自动填入文本。
- 自动转写不可用时保留手工校对/输入路径。
- 口语记录录音时长、语速线索、文本维度和评分版本。

### 配置 DeepSeek 后启用

在 `.env.local` 中配置：

```text
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

- 翻译、写作和口语转写文本通过 DeepSeek Chat Completions JSON Output 批改。
- 服务端对返回 JSON 再做量表字段、分数范围、维度标签和权重校验。
- 录音优先使用浏览器 Speech Recognition；朗读使用 Web Speech TTS；不可用时保留手动文本。

DeepSeek 密钥未填写时，应用自动回退到本地可解释量表，不中断学习。文本转写和量表不能替代真正的音素级声学发音评测；若需要音素、重音和时间段定位，仍需另外配置支持该能力的外部服务。

## 6. 一键运行、手机和 HTTPS

1. 双击 `一键打开AIEnglish.cmd`。启动过程会先做在线 SQLite 备份，再生产构建、后台启动和健康检查。
2. 关闭时双击 `一键关闭AIEnglish.cmd`。
3. 手机与电脑连接同一 Wi-Fi，打开启动窗口显示的 Mobile 地址。
4. HTTP 4173 可直接访问；手机麦克风通常要求安全上下文，建议使用 HTTPS 4174。

本地 HTTPS 已通过 `npm run https:setup` 生成：

```text
.runtime\https\local-root-ca.crt
.runtime\https\server-cert.pem
.runtime\https\server-key.pem
```

首次在手机使用 HTTPS 时，把 `local-root-ca.crt` 安装为受信任证书，然后访问启动窗口显示的 `https://局域网IP:4174/`。Wi-Fi 地址变化后重新执行 `npm run https:setup` 并重启。安装受信任证书属于设备安全设置，必须由设备所有者手动确认。

## 7. 数据库维护

```powershell
npm run db:verify
npm run db:backup
npm run db:restore -- backups\ai-english_YYYY-MM-DD_HH-mm-ss.sqlite
```

- 当前 schema version：3。
- 启动自动保留最近 14 份备份。
- 恢复前会验证备份完整性；若托管服务仍在运行，脚本拒绝覆盖主库。
- 本轮已实际完成“主库在线备份 → 恢复到临时库 → 完整性与 1000 篇行数验证”。

## 8. 已执行验收

| 检查 | 结果 |
| --- | --- |
| `npm run content:validate` | 1000/1000，通过，0 错误 |
| SQLite 内容与来源 | 1000 篇、1000 个唯一来源 |
| `PRAGMA integrity_check` | `ok` |
| 数据库备份与恢复演练 | 通过，恢复库 schema 3、1000 篇 |
| `npm test` | API 集成测试通过 |
| `npm run test:ui` | 桌面与手机 Edge/Playwright 测试通过 |
| `npm run build` | TypeScript 与 Vite 生产构建通过 |
| 横向溢出、框架错误层、console error | 桌面和手机均无 |
| 一键关闭/启动、HTTP 健康检查 | 实际执行通过 |
| HTTPS 证书生成、4174 监听 | 实际执行并验证 |

应用内 Browser 插件因其受信任运行时路径解析错误无法连接，UI 验收按测试工作流回退到项目内 Playwright + 系统 Edge；截图位于系统临时 QA 目录，不进入 Git。

## 9. 当前问题与外部依赖

1. `DEEPSEEK_API_KEY` 仍需在被 Git 忽略的 `.env.local` 中填写，之后才能完成真实计费调用验收。
2. 未配置音素级发音评测供应商；系统明确标注当前口语为转写文本和节奏线索评分，不声称听到了发音。
3. 本地 CA 不能远程替用户修改手机信任设置；需要在真实手机上手动安装证书并最终验收麦克风和“添加到主屏幕”。
4. 内容抓取结果保留原始 URL、来源说明和许可元数据。个人使用也建议保留这些记录，并在来源变化时重新检查。

以上均为外部凭据或设备操作，不阻塞当前本地 1.0 的使用。

## 10. 后续维护计划

- 每周运行一次 `content:refresh`，对失败来源复查并重采集。
- 每次结构变更新增迁移，不直接手工改运行数据库。
- 每次发布执行内容校验、API 测试、UI 测试、生产构建和恢复演练。
- 配置 API 密钥后补跑真实 DeepSeek 文本批改验收，并记录模型与费用。
- 若需要音素级发音反馈，选定供应商后接入 `pronunciation_assessments`，保留当前诚实降级路径。
- 在实际手机安装本地 CA、测试麦克风、PWA 安装和网络切换。

## 11. 主要交付文件

| 文件 | 用途 |
| --- | --- |
| `server/app.mjs` | 登录、安全、学习、内容、音频、复习和报告 API；HTTP/HTTPS 服务 |
| `server/database.mjs` | SQLite 主模型、内容同步、进度、评分、生词、复习、周报 |
| `server/migrations.mjs` | schema 1→3 可重复迁移 |
| `server/grading.mjs` | 本地量表、DeepSeek JSON 批改与可选 OpenAI Responses 批改 |
| `server/audio.mjs` | 可选 OpenAI 转写和 TTS |
| `scripts/crawl-vital-content.mjs` | 1000 篇联网采集、去重、分级与报告生成 |
| `scripts/content-pipeline.mjs` | 内容结构、质量、重复和来源校验 |
| `scripts/database-maintenance.mjs` | 验证、在线备份和恢复 |
| `scripts/setup-local-https.ps1` | 本地 CA 与局域网 SAN 证书生成 |
| `src/App.tsx` | 档案馆学习 UI、生词本、复习和周报 |
| `tests/api.test.mjs` | 数据库、认证、安全、音频降级、评分、复习 API 测试 |
| `tests/ui.test.mjs` | 桌面与手机端交互和视觉烟雾测试 |

## 12. 状态维护规则

- 功能、内容批次、数据库结构或测试结论变化后同步更新本文。
- 只有实际执行过的项目才标记“通过”。
- 不在代码、文档或 Git 中保存明文密码、API 密钥、会话、SQLite 主库、备份或证书私钥。
