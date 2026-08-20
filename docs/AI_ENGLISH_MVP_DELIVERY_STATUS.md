# AIEnglish 1.0 交付与运行手册

> 更新时间：2026-08-20<br>
> 当前版本：1.0.0<br>
> 产品基线：[AI_ENGLISH_APP_PRODUCT_UI_PLAN.md](./AI_ENGLISH_APP_PRODUCT_UI_PLAN.md)

## 1. 当前结论

AIEnglish 已按产品方案完成档案馆编辑风格 MVP，并将语音链路统一切换到腾讯云。系统不再读取或调用 DeepSeek/OpenAI；文章与词汇朗读使用腾讯云 TTS，转写适配器使用腾讯云 ASR，口语使用腾讯智聆口语评测新版 SOE-N 的真实录音声学评分。口语没有文本输入框，也不存在本地口语分数。

1000 篇内容已保留并同步到 SQLite，原有学习记录在迁移前完成备份。当前数据库完整性为 `ok`，schema version 为 4，课程数为 1000。

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
| 三个环节使用相同原文 | 完成 | 听力、全文翻译、口语复述均直接读取 `lesson.body`；页面仅以自然段展示 |
| 真实录音口语评测 | 完成代码 | 必须先录音；前端转换为 16kHz/16bit/mono WAV；SOE-N 返回精准度、流利度、完整度及低分词/音素 |
| 取消本地口语评分 | 完成 | 所有口语维度和总分来自腾讯 SOE-N；本地只负责格式转换、停顿切段和分数加权汇总 |
| L1 写作降难度 | 完成 | 第一篇改为 A2–B1 句型：`The useful lesson is not to wait for a perfect workout.` |
| 重点词汇朗读 | 完成代码 | 每篇固定 5 个重点词，每个词旁有腾讯云读音按钮 |
| 手机听力与麦克风 | 完成自动测试，待真机终验 | 390px 无横向溢出、录音入口存在、无口语文本框；HTTPS 服务和当前 IP 证书已验证 |
| 内容与数据库 | 完成 | 1000 篇，L1/L2/L3 为 350/400/250，1000/1000 通过质量流水线 |
| 运维与保护 | 完成 | 一键启停、启动前备份、迁移、完整性校验、HTTP/HTTPS 健康检查 |

## 3. 腾讯云架构

| 能力 | 腾讯云服务 | 当前实现 |
| --- | --- | --- |
| 文章听力 | 语音合成 TTS `TextToVoice` | 英文音色 101050、三档语速、长文分段、服务端 MP3 缓存、HTTP Range |
| 重点词读音 | 语音合成 TTS | 每个词独立合成并缓存 |
| 语音转写 | 一句话识别 ASR `SentenceRecognition` | `16k_en`，接口层已独立，后续可以替换更便宜的 ASR |
| 口语评分 | 智聆口语评测新版 SOE-N | `16k_en`、段落模式、成人严格系数 4.0、真实 WAV 流式上传 |
| 全文翻译参考 | 机器翻译 TMT `TextTranslate` | 腾讯参考译文 + 本地确定性量表；不是大语言模型 |
| 写作批改 | 本地分级量表 | 按 L1/L2/L3 参考答案批改；不调用 DeepSeek |

腾讯智聆段落模式单个参考片段最多 120 个英文词。正文保持完整；超过限制的正文优先在接近中点的句子边界切成两个参考片段，录音则在对应位置附近搜索低能量停顿点切分。各片段的原始腾讯分数按参考词数加权汇总，不生成任何本地口语分数。

接口依据腾讯云官方文档实现：

- [智聆口语评测新版接口](https://cloud.tencent.com/document/product/1774/107497)
- [一句话识别](https://cloud.tencent.com/document/api/1093/35646)
- [语音合成 TextToVoice](https://cloud.tencent.com/document/api/1073/37995)

## 4. 仍需填写的腾讯云配置

代码、环境模板和本机配置槽位都已准备好，但当前 `.env.local` 中腾讯云三项凭据仍为空，因此云端 TTS/ASR/SOE-N/TMT 尚不能进行真实计费调用。

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
```

腾讯云控制台需要开通：语音合成、语音识别、智聆口语评测新版、机器翻译。填写后执行：

```powershell
npm run tencent:verify -- --config-only
npm run tencent:verify
```

第一条验证三项凭据和 SOE-N 签名配置；第二条真实调用 TTS，返回音色、音频字节数和缓存状态，但不会输出密钥。随后重启应用。

## 5. 内容库

- `content/lessons.json`：1000 篇可审查内容基线。
- 每篇听力、翻译提示和口语参考均为同一个完整 `body`。
- 每篇 5 个重点词，包含 IPA、词性、中文释义和独立朗读入口。
- L1 写作任务已重新降阶；L2/L3 保留相应难度。
- `content/crawl-report.json` 保存采集批次和难度统计。
- `content/ingestion-report.json` 保存最新结构、去重、来源和质量校验结果。

内容命令：

```powershell
npm run content:normalize
npm run content:validate
npm run content:refresh
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

schema 4 将旧版 0–10 口语成绩迁移为 0–100，并标记为历史文本评测；新提交的口语记录保存腾讯供应商、声学评测标记、原始维度、低分词、录音哈希和提交版本。数据库、备份、音频缓存、`.env.local` 与私钥都被 `.gitignore` 排除。

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
| `npm test` | 7/7，通过：认证/数据库/API、腾讯 TC3/SOE 签名、切段、真实录音及真实时长闸门、写作和 TMT 量表 |
| `npm run test:ui` | 通过：桌面与 390px 手机、六步、全文段落、5 个词汇喇叭、无口语文本框、无溢出/控制台错误 |
| `npm run build` | TypeScript 与 Vite 生产构建通过 |
| `npm run db:verify` | integrity `ok`、schema 4、1000 篇 |
| HTTP 健康检查 | 4173 返回 200，schema 4 |
| HTTPS 健康检查 | 4174 返回 200，schema 4 |
| 当前 IP 证书 SAN | 包含 `192.168.150.107` |
| 启动前数据库备份 | 已生成 schema 3、1000 篇的迁移前备份 |
| `npm run tencent:verify` | 待凭据；当前准确提示缺少 AppID、SecretId、SecretKey |

应用内浏览器连接因 Windows 中文用户路径的受信任路径校验未能建立；依据前端测试工作流，改用项目 Playwright + 系统 Edge 完成同等交互验收。真实腾讯云音频与真实手机麦克风仍必须在填写凭据、手机信任根证书后做最终人工试听/录音。

## 9. 当前问题

1. 腾讯云三项凭据尚未填写，云端调用尚未实调。这是当前唯一代码外阻塞项。
2. 需要在腾讯云控制台确认四项服务已开通、密钥有权限且账户有可用额度。
3. 自动化已覆盖手机尺寸和 HTTPS 服务，但无法替用户在真实 Android/iPhone 上安装根证书或确认系统麦克风授权。

## 10. 下一步

1. 填写腾讯云三项凭据并开通服务。
2. 执行 `npm run tencent:verify`，确认真实 TTS。
3. 重启后在手机 HTTPS 地址完成一篇：听力 → 录音 → 回听 → SOE-N 评分。
4. 核对腾讯控制台调用量和账单，再决定是否替换 ASR；TTS 与 SOE-N 接口无需改动。

## 11. 主要交付文件

| 文件 | 用途 |
| --- | --- |
| `server/tencent-cloud.mjs` | TC3 签名、TTS、ASR、TMT、SOE-N 流式评分、音频缓存和切段 |
| `server/audio.mjs` | 可替换的腾讯音频适配层和朗读清单 |
| `server/grading.mjs` | TMT 全文参考、翻译/写作规则量表；拒绝文本口语提交 |
| `server/app.mjs` | 音频清单、Range 播放、转写和真实录音评分 API |
| `server/migrations.mjs` | schema 1→4 迁移 |
| `scripts/normalize-learning-content.mjs` | 原文一致、L1 写作、5 个重点词规范化 |
| `scripts/verify-tencent.mjs` | 不输出密钥的腾讯配置和真实 TTS 验证 |
| `src/lib/audio.ts` | 手机/桌面录音解码、单声道混音、16kHz WAV 转换 |
| `src/App.tsx` | 全文段落、腾讯朗读、词汇喇叭和真实录音口语 UI |
| `tests/api.test.mjs` | schema 4、内容、认证、腾讯能力和业务 API |
| `tests/grading.test.mjs` | 腾讯签名、切段、文本口语闸门及批改测试 |
| `tests/ui.test.mjs` | 桌面和手机关键流程专项测试 |

## 12. 状态维护规则

- 功能、内容、数据库结构或测试结论变化后同步更新本文。
- 只有实际执行过的项目才标记“通过”。
- 不在代码、文档或 Git 中保存明文密码、API 密钥、会话、运行数据库、备份或证书私钥。
