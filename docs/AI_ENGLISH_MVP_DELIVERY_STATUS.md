# AIEnglish 1.0 交付与运行手册

> 最新上线判断以 [2026-08-26 优化实施与复验](./RELEASE_OPTIMIZATION_2026-08-26.md) 为准；本页下方保留原有产品交付背景。

> 更新时间：2026-08-20<br>
> 当前版本：1.0.0<br>
> 产品基线：[AI_ENGLISH_APP_PRODUCT_UI_PLAN.md](./AI_ENGLISH_APP_PRODUCT_UI_PLAN.md)

新会话接手请先阅读：[NEXT_SESSION_HANDOFF.md](./NEXT_SESSION_HANDOFF.md)。

## 1. 当前结论

AIEnglish 已按产品方案完成档案馆编辑风格 MVP，并将语音链路统一切换到腾讯云。系统不再读取或调用 DeepSeek/OpenAI；文章与词汇朗读使用腾讯云 TTS，转写适配器使用腾讯云 ASR，口语使用腾讯智聆口语评测新版 SOE-N 的真实录音声学评分。口语没有文本输入框，也不存在本地口语分数。

1000 篇内容已保留并同步到 SQLite，原有学习记录在迁移前完成备份。单词模块已导入用户提供的托福、雅思、六级三本词书，并补充 Oxford、Cambridge、Open English WordNet 与 ECDICT 字段。当前运行库共 30,614 条单词/词组，其中词组 10,760 条；数据库完整性为 `ok`，schema version 为 6，课程数为 1000。

当前访问地址：

- 电脑 HTTP：`http://127.0.0.1:4173/`
- 电脑 HTTPS：`https://127.0.0.1:4174/`
- 手机 HTTP：`http://192.168.150.107:4173/`
- 手机 HTTPS：`https://192.168.150.107:4174/`
- 登录用户：`LEVEN`
- 密码和云密钥仅保存在本机 `.env.local`，不会进入 Git

## 2. 任务目标与完成情况

| 目标 | 状态 | 实际结果 |
| --- | --- | --- |
| 档案馆 UI 与六步流程 | 完成 | 六步进度位于“今日学习”正下方；导读、听力、翻译、口语、写作、总结连续解锁 |
| 文章重学与下一篇 | 完成 | 学习中可重新开始，完成/跳过后可重学或进入下一篇；旧轮次归档到 `lesson_runs`，提交和评分历史不删除 |
| 三个环节使用相同原文 | 完成 | 听力、全文翻译、口语复述均直接读取 `lesson.body`；页面仅以自然段展示 |
| 真实录音口语评测 | 完成代码 | 必须先录音；前端转换为 16kHz/16bit/mono WAV；SOE-N 返回精准度、流利度、完整度及低分词/音素 |
| 取消本地口语评分 | 完成 | 所有口语维度和总分来自腾讯 SOE-N；本地只负责格式转换、停顿切段和分数加权汇总 |
| L1 写作降难度 | 完成 | 350/350 篇通过 5–9 词简单句规则；第一篇为 `I can walk for ten minutes every day.`，并接受多个自然变体 |
| 完整听力与实时调速 | 完成并实测 | 腾讯分段仅存在于服务端生成阶段；FFmpeg 合并为一条自然语速 MP3，前端实时调速、暂停续播、10秒快退/快进和任意拖动 |
| 重点词汇朗读 | 完成 | 每篇固定 5 个重点词；文章打开后顺序预热，点击使用浏览器长期缓存立即播放 |
| 查词与背单词 | 完成 | 30,614 条查词总库；支持中英文检索、词性、音标、词根联想、释义、例句、词形、来源词表与腾讯云读音 |
| 三本用户词书 | 完成 | 托福 4,119、雅思 3,503、六级 2,412 条；可选择词书与每日 10/20/30/50 个新词 |
| 单词复习调度 | 完成 | 到期词优先、新词补足；忘记/困难/记得/熟悉四档调度，支持加入、跳过、掌握、恢复和移除 |
| 一秒发音方案 | 完成并实测 | 搜索前两条、词条详情、当前词卡和下一词卡提前预载；浏览器内存 + Service Worker + 服务端三级缓存；缓存就绪后实测点击到播放调用 29ms |
| 录音回听与重评 | 完成 | 结束录音后显示时长和播放器；提交前后均可回听、放弃或重新录音，再次提交会形成新的评分版本 |
| 错题与生词操作 | 完成 | 支持跳过今天、标记掌握、删除与7秒撤销；错题删除为可恢复归档，原始提交历史保留 |
| 手机听力与麦克风 | 完成自动测试，待真机终验 | 390px 无横向溢出；完整进度条、实时调速、假设备录音、回听和重录自动测试通过 |
| 内容与数据库 | 完成 | 1000 篇，L1/L2/L3 为 350/400/250，1000/1000 通过质量流水线 |
| 运维与保护 | 完成 | 一键启停、启动前备份、迁移、完整性校验、HTTP/HTTPS 健康检查 |

## 3. 腾讯云架构

| 能力 | 腾讯云服务 | 当前实现 |
| --- | --- | --- |
| 文章听力 | 语音合成 TTS `TextToVoice` | 英文音色 101050、仅生成自然语速、长文内部切段后合并为完整 MP3、播放器实时调速、HTTP Range |
| 重点词与词典读音 | 语音合成 TTS | 每个词独立合成；详情/当前卡/下一卡优先预热，浏览器、PWA 与服务端三级缓存，请求并发去重 |
| 语音转写 | 一句话识别 ASR `SentenceRecognition` | `16k_en`，接口层已独立，后续可以替换更便宜的 ASR |
| 口语评分 | 智聆口语评测新版 SOE-N | `16k_en`、段落模式、成人严格系数 4.0、真实 WAV 流式上传 |
| 全文翻译参考 | 可选机器翻译 TMT `TextTranslate` | 默认关闭并使用规则量表；开通 TMT 后可启用腾讯参考译文，失败时自动降级 |
| 写作批改 | 本地分级量表 | 按 L1/L2/L3 参考答案批改；不调用 DeepSeek |

腾讯智聆段落模式单个参考片段最多 120 个英文词。正文保持完整；超过限制的正文优先在接近中点的句子边界切成两个参考片段，录音则在对应位置附近搜索低能量停顿点切分。各片段的原始腾讯分数按参考词数加权汇总，不生成任何本地口语分数。

接口依据腾讯云官方文档实现：

- [智聆口语评测新版接口](https://cloud.tencent.com/document/product/1774/107497)
- [一句话识别](https://cloud.tencent.com/document/api/1093/35646)
- [语音合成 TextToVoice](https://cloud.tencent.com/document/api/1073/37995)

## 4. 腾讯云配置与实测状态

AppID、SecretId 和 SecretKey 已填写，配置校验、SOE-N 签名和真实 TTS 调用均已通过。最新完整文章实调使用英文音色 101050，生成 362,709 字节、60.41 秒的可解码 MP3；Range 请求返回 `206` 和正确 `Content-Range`，服务已重启并加载凭据。

在 `.env.local` 填写：

```text
TENCENTCLOUD_APP_ID=你的AppID
TENCENTCLOUD_SECRET_ID=你的SecretId
TENCENTCLOUD_SECRET_KEY=你的SecretKey
TENCENTCLOUD_REGION=ap-guangzhou
TENCENT_TTS_VOICE_TYPE=101050
TENCENT_TTS_MODEL_TYPE=1
TENCENT_ASR_ENGINE=16k_en
TENCENT_SOE_SCORE_COEFF=4.0
TENCENT_TMT_ENABLED=false
```

腾讯云控制台需要开通：语音合成、语音识别、智聆口语评测新版。机器翻译 TMT 尚未开通，当前已明确设置为可选且默认关闭，不影响听力、口语和规则批改；如以后开通，再将 `TENCENT_TMT_ENABLED` 改为 `true`。

```powershell
npm run tencent:verify -- --config-only
npm run tencent:verify
```

第一条验证三项凭据和 SOE-N 签名配置；第二条真实调用 TTS，返回音色、音频字节数和缓存状态，但不会输出密钥。

## 5. 内容库

- `content/lessons.json`：1000 篇可审查内容基线。
- 每篇听力、翻译提示和口语参考均为同一个完整 `body`。
- 每篇 5 个重点词，包含 IPA、词性、中文释义和独立朗读入口。
- 350 篇 L1 写作任务全部重新降阶到 5–9 个词、一个具体动作或事实；内容流水线会拒绝超长答案和复杂从句。
- 第一篇题目为“我每天可以步行十分钟。”，保存 3 个自然英文答案变体。
- L2/L3 保留相应难度，评分继续接受多个参考表达。
- `content/crawl-report.json` 保存采集批次和难度统计。
- `content/ingestion-report.json` 保存最新结构、去重、来源和质量校验结果。

单词库：

- `content/word-library-report.json` 保存词书解析数量、字段覆盖率、总库指纹与各来源条数。
- 用户提供词书：托福 4,119 条、雅思 3,503 条、六级 2,412 条，保留书内词根联想、释义与可识别例句。
- 官方补充：Oxford 3000 & 5000 为 4,952 条、Oxford Phrase List 为 734 条、Cambridge A2 为 806 条、Cambridge B1 为 1,398 条、Open English WordNet 为 29,581 条。
- 总库经去重与课文重点词自动补充后为 30,614 条；29,000+ 条已有中文释义，19,000+ 条已有 IPA。
- 原始 EPUB/AZW 只作本机导入源，不进入 Git；业务运行读取 SQLite，不依赖下载目录中的电子书持续存在。

内容命令：

```powershell
npm run content:normalize
npm run content:validate
npm run content:refresh
npm run word-library:import
```

## 6. 数据保存与迁移

运行主库：

```text
C:\Users\张作明\Documents\AiEnglish\data\ai-english.sqlite
```

自动备份：

```text
C:\Users\张作明\Documents\AiEnglish\backups\
```

腾讯云 TTS 音频缓存：

```text
C:\Users\张作明\Documents\AiEnglish\data\audio-cache\
```

运行日志、PID、采集缓存和 HTTPS 私钥：

```text
C:\Users\张作明\Documents\AiEnglish\.runtime\
```

schema 4 将旧版 0–10 口语成绩迁移为 0–100，并标记为历史文本评测；schema 5 增加重学轮次和错题生命周期；schema 6 增加词典、词书成员、用户背词偏好、单词进度、复习尝试、全文检索与单词音频资产表。数据库、备份、音频缓存、`.env.local` 与私钥都被 `.gitignore` 排除。

## 7. 一键运行与手机访问

1. 双击 `一键打开AIEnglish.cmd`。脚本先备份数据库，再生产构建、启动并检查健康状态。
2. 关闭时双击 `一键关闭AIEnglish.cmd`。
3. 手机和电脑连接同一 Wi-Fi。
4. 听力页面可用 HTTP，但手机麦克风必须使用 HTTPS 地址。
5. 把 `.runtime\https\local-root-ca.crt` 安装为手机受信任根证书，再访问 `https://192.168.150.107:4174/`。
6. Wi-Fi 地址变化后重新执行 `npm run https:setup` 并重启。

本轮已重新签发服务证书，SAN 包含当前地址 `192.168.150.107`；根 CA 没有更换。

## 8. 已执行验收

| 检查 | 结果 |
| --- | --- |
| `npm run content:validate` | 1000/1000，通过，0 错误 |
| `npm test` | 7/7，通过：认证/数据库/API、schema 6、查词/词条/背词状态、腾讯 TC3/SOE 签名、切段、真实录音闸门、写作和 TMT 量表 |
| `npm run test:ui` | 通过：桌面与 390px 手机、六步学习、词书入口、查词详情、5 项手机底栏、假设备录音回听/重录、无溢出/控制台错误 |
| `npm run build` | TypeScript 与 Vite 生产构建通过 |
| `npm run db:verify` | integrity `ok`、schema 6、1000 篇、30,614 条词典数据 |
| HTTP 健康检查 | 4173 返回 200，schema 6 |
| HTTPS 健康检查 | 4174 返回 200，schema 6 |
| 完整音频实调 | 362,709 字节、60.41 秒、FFmpeg 解码退出码 0；Range `bytes 0-4095/362709` 返回 206 |
| 当前 IP 证书 SAN | 包含 `192.168.150.107` |
| 启动前数据库备份 | 已保留 schema 5 迁移前备份，并在 schema 6 词库导入和每次实际启动前继续自动备份 |
| `npm run tencent:verify -- --config-only` | 通过：TTS、ASR、SOE-N 能力已配置，严格度 4.0，SOE 签名生成成功 |
| `npm run tencent:verify` | 真实 TTS 通过：TextToVoice、音色 101050、11,088 字节、首次生成非缓存 |
| 真实词库 UI 验收 | 30,614 条可读；`abandon` 查询/详情正常；托福词书背词和复习落库成功；桌面/手机溢出均为 0；失败请求和控制台错误均为 0 |
| 单词一秒播放 | 腾讯云音频预载后，点击到 `HTMLMediaElement.play()` 实测 29ms |

应用内浏览器连接因 Windows 中文用户路径的受信任路径校验未能建立；依据前端测试工作流，改用项目 Playwright + 系统 Edge 完成同等交互验收。真实完整 TTS、合并、解码和拖动所需的 Range 响应均已通过；真实手机麦克风和 SOE-N 声学评分仍需在手机信任根证书后完成一次人工录音。

## 9. 当前问题

1. 30,614 条词典音频采用“按需生成 + 提前预载 + 三级缓存”，没有一次性预生成全部音频；任意冷门词第一次出现在搜索结果时会先显示预载状态，缓存后立即播放。
2. 腾讯 TTS 已实调；ASR 与 SOE-N 已配置并签名成功，但 SOE-N 仍需要用户真实英语录音完成最终声学调用。
3. 腾讯机器翻译 TMT 尚未开通，已默认关闭并提供规则降级，不阻塞学习。
4. 自动化已覆盖手机尺寸和 HTTPS 服务，但无法替用户在真实 Android/iPhone 上安装根证书或确认系统麦克风授权。

## 10. 下一步

1. 在手机安装并信任本地根证书，通过 HTTPS 完成一篇：听力 → 录音 → 回听 → SOE-N 评分。
2. 正常使用三本词书；系统会随查词和背词自动积累本地音频缓存，无需一次性消耗全部 TTS 额度。
3. 用户提供 BBC 或其他词书文件后，沿用同一导入流水线增加可选词书。
4. 核对腾讯控制台调用量和账单，再决定是否替换 ASR；TTS 与 SOE-N 接口无需改动。

## 11. 主要交付文件

| 文件 | 用途 |
| --- | --- |
| `server/tencent-cloud.mjs` | TC3 签名、TTS、ASR、TMT、SOE-N 流式评分、音频缓存和切段 |
| `server/audio.mjs` | 自然语速完整音频缓存、FFmpeg 合并、并发请求去重和朗读清单 |
| `server/grading.mjs` | TMT 全文参考、翻译/写作规则量表；拒绝文本口语提交 |
| `server/app.mjs` | 音频清单、Range 播放、词典/背词、转写和真实录音评分 API |
| `server/database.mjs` | 课程、词典搜索、词书偏好、四档复习调度和用户进度持久化 |
| `server/migrations.mjs` | schema 1→6 迁移；增加词典、词书、复习进度、FTS 与音频资产表 |
| `scripts/import-word-library.mjs` | EPUB/AZW、Oxford、Cambridge、OEWN 与 ECDICT 解析、去重、补全和入库流水线 |
| `scripts/normalize-learning-content.mjs` | 原文一致、350篇 L1 简单写作、多个答案和5个重点词规范化 |
| `scripts/verify-tencent.mjs` | 不输出密钥的腾讯配置和真实 TTS 验证 |
| `src/lib/audio.ts` | 手机/桌面录音解码、单声道混音、16kHz WAV 转换 |
| `src/App.tsx` | 完整听力时间轴、实时调速、词汇预热、重学/下一篇、复盘操作和录音回听重评 UI |
| `src/DictionaryView.tsx` | 档案馆风格查词、词书选择、词条详情、发音、背词卡和四档反馈 UI |
| `src/lib/audio-cache.ts` | 音频能力探测、优先级预载、浏览器内存缓存与并发控制 |
| `public/sw.js` | 应用壳与腾讯云音频的 PWA 持久缓存 |
| `tests/api.test.mjs` | schema 6、内容、词典/背词、重学、错题/生词生命周期、腾讯能力和业务 API |
| `tests/grading.test.mjs` | 腾讯签名、切段、文本口语闸门及批改测试 |
| `tests/ui.test.mjs` | 桌面和手机关键流程专项测试 |

## 12. 状态维护规则

- 功能、内容、数据库结构或测试结论变化后同步更新本文。
- 只有实际执行过的项目才标记“通过”。
- 不在代码、文档或 Git 中保存明文密码、API 密钥、会话、运行数据库、备份或证书私钥。
