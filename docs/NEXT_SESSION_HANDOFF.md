# AIEnglish 新会话交接

> 2026-08-26 更新：以下是历史交接。当前数据库为 schema 9，最新安全/性能/多端实施和待上线条件请先阅读 [优化实施与复验](./RELEASE_OPTIMIZATION_2026-08-26.md) 及 [部署与恢复](./DEPLOYMENT_AND_RECOVERY.md)。本轮已启用当前 Windows 用户可信的本地 HTTPS；不要将桌面移动模拟视为 Android/iOS 真机通过。

> 交接时间：2026-08-21（Asia/Shanghai）
> 工作区：`C:\Users\张作明\Documents\AiEnglish`
> 当前基线提交：`d30d65e fix: make Tencent translation optional`
> 详细交付状态：[AI_ENGLISH_MVP_DELIVERY_STATUS.md](./AI_ENGLISH_MVP_DELIVERY_STATUS.md)

## 1. 当前结论

AIEnglish 的档案馆编辑风格 MVP、1000 篇课程、腾讯云语音链路和第一版单词模块均已完成。运行数据库已经迁移到 schema 6；当前词典共 30,614 条，其中词组 10,760 条。应用正在生产模式运行，HTTP 健康检查返回 `ok: true`、`schemaVersion: 6`。

当前实现不接入 DeepSeek。听力和词汇发音使用腾讯云 TTS；口语必须提交真实录音，并由腾讯智聆 SOE-N 评分，不使用本地口语分数。

## 2. 已完成内容

### 原有学习系统

- 1000 篇课程已存入 SQLite，L1/L2/L3 分布为 350/400/250。
- 导读、听力、翻译、口语、写作、总结六步流程完整。
- 听力、翻译和口语复述共用同一个自然段原文。
- 支持跳过、下一篇、重学、错题和生词的删除/跳过/掌握/恢复。
- 完整文章只缓存一份自然语速音频，0.75×/1×/1.25× 由播放器实时调速。
- 口语支持录音、回听、重录和重新评测；手机录音转换为腾讯要求的 16kHz/16bit/mono WAV。
- L1 写作已降低到短句难度，第一篇为“我每天可以步行十分钟。”。

### 单词模块

- 用户词书已入库：托福 4,119 条、雅思 3,503 条、六级 2,412 条。
- 查词补充来源：Oxford 3000 & 5000、Oxford Phrase List、Cambridge A2/B1、Open English WordNet、ECDICT。
- 支持英文、词组和中文释义搜索。
- 词条可显示音标、词性、中英文释义、词根联想、例句、词形和来源词表。
- 支持选择词书、每日 10/20/30/50 个新词、到期词优先复习。
- 支持“忘记、困难、记得、熟悉”四档复习，以及加入、跳过、掌握、恢复、移除。
- 音频使用腾讯云按需生成，并采用浏览器内存、Service Worker、服务端三级缓存。
- 搜索前两条、词条详情、当前词卡和下一词卡会提前预载；最终实测点击到播放调用约 30ms。
- 没有一次性预生成 30,614 条音频；冷门词第一次出现时先预载，之后立即播放。

## 3. 数据与文件位置

| 内容 | 位置 |
| --- | --- |
| 运行数据库 | `data\ai-english.sqlite` |
| 自动备份 | `backups\` |
| 腾讯云音频缓存 | `data\audio-cache\` |
| 环境配置 | `.env.local` |
| 服务 PID/日志/证书 | `.runtime\` |
| 1000 篇课程基线 | `content\lessons.json` |
| 词库导入报告 | `content\word-library-report.json` |
| 最新交付文档 | `docs\AI_ENGLISH_MVP_DELIVERY_STATUS.md` |

数据库、备份、音频缓存、密钥、PID、日志和 HTTPS 私钥均被 `.gitignore` 排除。不要把 `.env.local`、运行数据库或备份加入 Git。

## 4. 关键实现文件

| 文件 | 作用 |
| --- | --- |
| `scripts/import-word-library.mjs` | EPUB/AZW、官方词表、OEWN、ECDICT 解析与入库 |
| `server/migrations.mjs` | schema 1→6 数据库迁移 |
| `server/database.mjs` | 课程、查词、词书、背词偏好、复习调度和进度持久化 |
| `server/app.mjs` | 登录、学习、词典、音频和评分 API |
| `server/audio.mjs` | 完整文章音频、预热、合并与请求去重 |
| `server/tencent-cloud.mjs` | 腾讯 TTS、ASR、TMT、SOE-N 与本地音频缓存 |
| `src/DictionaryView.tsx` | 查词、词书选择、词条详情和背词 UI |
| `src/lib/audio-cache.ts` | 前端音频能力探测、优先级预载与内存缓存 |
| `public/sw.js` | PWA 应用壳与音频持久缓存 |
| `tests/api.test.mjs` | schema 6、词典/背词和原有业务 API 测试 |
| `tests/ui.test.mjs` | 桌面和 390px 手机关键流程测试 |

## 5. 当前运行状态

- 电脑 HTTP：`http://127.0.0.1:4173/`
- 电脑 HTTPS：`https://127.0.0.1:4174/`
- 手机 HTTP：`http://192.168.150.107:4173/`
- 手机 HTTPS：`https://192.168.150.107:4174/`
- 当前托管 PID：`24712`（新会话应重新读取 `.runtime\ai-english.pid`，不要依赖此静态数字）
- 登录用户名和密码、腾讯云凭据只从 `.env.local` 读取；本文件不记录实际值。

一键运行：

```powershell
.\一键打开AIEnglish.cmd
.\一键关闭AIEnglish.cmd
```

## 6. 最近验收结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | 7/7 通过 |
| `npm run test:ui` | 通过，桌面与 390px 手机无横向溢出和控制台错误 |
| `npm run content:validate` | 1000/1000，通过，0 错误 |
| `npm run build` | TypeScript 与 Vite 生产构建通过 |
| `npm run db:verify` | integrity `ok`，schema 6，1000 篇 |
| 真实词库验收 | 30,614 条可读；搜索、详情、托福背词和复习落库通过 |
| 腾讯云发音 | 云能力可用；预载完成后点击到播放调用约 30ms |
| HTTP/HTTPS 健康检查 | 4173/4174 均返回 200、schema 6 |

应用内浏览器曾因 Windows 中文用户路径的受信任路径校验无法连接；已使用项目 Playwright + 系统 Edge 完成等价桌面/手机验收。

## 7. Git 状态：务必保留

当前工作树有大量尚未提交的本轮实现，包括原有语音/内容优化和新单词模块。不要执行 `git reset --hard`、`git checkout --` 或覆盖式还原。

主要未提交文件：

- 修改：`README.md`、`content/lessons.json`、交付文档、服务器、前端、测试、PWA 和脚本。
- 新增：`content/word-library-report.json`、`scripts/import-word-library.mjs`、`src/DictionaryView.tsx`、`src/lib/audio-cache.ts`。
- 运行数据和备份未被 Git 跟踪，这是预期行为。

新会话开始后先执行：

```powershell
git status --short
git diff --check
npm run db:verify
```

如果用户要求提交，再审查差异并创建提交；不要擅自丢弃现有修改。

## 8. 尚需用户/真机完成的事项

1. 在真实 Android/iPhone 安装并信任本地根证书。
2. 通过手机 HTTPS 完成一次：听力 → 录音 → 回听 → 腾讯 SOE-N 评分。
3. 用户提供 BBC 或其他词书文件后，沿用现有导入流水线增加词书。
4. 根据腾讯控制台实际调用量决定是否更换 ASR；TTS 与 SOE-N 无需重构。
5. 是否对当前工作树创建 Git 提交，等待用户明确指令。

## 9. 不可破坏的产品约束

- 保留 1000 篇课程、现有学习记录和数据库备份。
- 听力、翻译、口语使用完全相同的自然段原文。
- 口语没有可编辑文本框，必须有真实录音才能提交评分。
- 不伪造腾讯云评分；失败时显示明确错误。
- 不重新接入 DeepSeek，除非用户以后明确改变决定。
- 文章只保存自然语速完整音频，其他速度由播放器实时调速。
- 所有密钥和密码只放 `.env.local`，不得输出或提交。

## 10. 新会话直接接手指令

可把下面这段作为新会话第一条消息：

> 继续 AIEnglish。先完整阅读 `docs/NEXT_SESSION_HANDOFF.md` 和 `docs/AI_ENGLISH_MVP_DELIVERY_STATUS.md`，检查当前 Git、数据库和服务状态，保留全部已有修改与学习数据，不要重做已完成模块。然后根据我新的需求继续开发；任何数据库结构修改前先备份，完成后运行 API、UI、内容、构建和数据库验收并同步交付文档。
