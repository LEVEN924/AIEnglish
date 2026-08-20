# AIEnglish 1.0

AIEnglish（Ink & Air）是一款个人每日英语学习应用。它以档案馆编辑风格把每篇内容组织成导读、听力、翻译、口语、写作和总结六步连续学习流程。

当前交付包含 1000 篇已入 SQLite 的 L1/L2/L3 内容（350/400/250）、可追溯来源、跳过本篇、跨设备进度、版本化批改、自动错题、1/3/7 天间隔复习、生词本、七日周报、PWA、一键启停、启动前备份以及可选局域网 HTTPS。语音统一接入腾讯云：TTS 负责文章和重点词朗读，ASR 保留为可替换转写适配层，智聆口语评测新版（SOE-N）直接对真实录音做成人严格声学评分；系统不接入 DeepSeek，也不使用本地口语评分。

## 文档

- [产品、内容与 UI 方案](docs/AI_ENGLISH_APP_PRODUCT_UI_PLAN.md)
- [MVP 交付与当前状态](docs/AI_ENGLISH_MVP_DELIVERY_STATUS.md)

## 本地运行

Windows 直接双击 `一键打开AIEnglish.cmd`，关闭时双击 `一键关闭AIEnglish.cmd`。启动窗口会显示电脑与手机访问地址。

开发模式：

```powershell
npm install
npm run dev
```

生产模式：

```powershell
npm run build
npm start
```

## 内容与测试

```powershell
npm run content:generate
npm run content:validate
npm run content:refresh
npm test
npm run test:ui
npm run build
```

运行数据库位于 `data/ai-english.sqlite`，并被 Git 忽略。`content/lessons.json` 是可审查、可重建的 1000 篇内容基线；`content/crawl-report.json` 和 `content/ingestion-report.json` 保存采集与校验结果。

数据库维护与本地 HTTPS：

```powershell
npm run db:verify
npm run db:backup
npm run db:restore -- backups\<backup-file>.sqlite
npm run tencent:verify
npm run https:setup
```

腾讯云只需在 `.env.local` 填写 `TENCENTCLOUD_APP_ID`、`TENCENTCLOUD_SECRET_ID` 和 `TENCENTCLOUD_SECRET_KEY`，并在控制台开通语音合成、语音识别和智聆口语评测新版。默认采用英文男声 `101050`、英语 `16k_en` 和成人严格系数 `4.0`。机器翻译 TMT 是可选能力，开通后把 `TENCENT_TMT_ENABLED` 改为 `true`；未开通或调用失败时自动使用规则量表，不影响学习流程。密钥仅由服务端读取，不会发送到浏览器或进入 Git。

完整状态、存储位置、验收结果和外部依赖见[交付文档](docs/AI_ENGLISH_MVP_DELIVERY_STATUS.md)。
