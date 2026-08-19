# AIEnglish 1.0

AIEnglish（Ink & Air）是一款个人每日英语学习应用。它以档案馆编辑风格把每篇内容组织成导读、听力、翻译、口语、写作和总结六步连续学习流程。

当前交付包含 1000 篇已入 SQLite 的 L1/L2/L3 内容（350/400/250）、可追溯来源、跳过本篇、跨设备进度、版本化批改、自动错题、1/3/7 天间隔复习、生词本、七日周报、PWA、一键启停、启动前备份以及可选局域网 HTTPS。默认使用 DeepSeek V4 Flash 完成文本结构化批改；浏览器朗读、浏览器转写和手动文本构成不依赖云端音频接口的稳定降级路径。

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
npm run https:setup
```

完整状态、存储位置、验收结果和外部依赖见[交付文档](docs/AI_ENGLISH_MVP_DELIVERY_STATUS.md)。
