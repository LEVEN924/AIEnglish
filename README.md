# AIEnglish 1.0

2026-08-26：已部署并接管原应用入口，正式访问地址为 [https://cayi-ai.top:20057](https://cayi-ai.top:20057)。已修正公网来源校验、旧手机浏览器登录兼容性，放宽 Nginx 录音上传至 16 MiB；腾讯评分改用录音模式，同一段 64 秒合成音频公网评分由 37.1 秒降至 15.7–16.7 秒（三轮均成功）。真人移动端登录与录音仍需用户复验，详见[实际部署状态](docs/SERVER_DEPLOYMENT.md)。

AIEnglish（Ink & Air）是一款个人每日英语学习应用。它以档案馆编辑风格把每篇内容组织成导读、听力、翻译、口语、写作和总结六步连续学习流程。

当前交付包含 1000 篇已入 SQLite 的 L1/L2/L3 内容（350/400/250），其中 50 篇作为精选主课程、950 篇明确标记为拓展阅读；所有写作任务都引用当前文章主题。系统支持登录与注册、自适应等级/主题推荐、逐句翻译反馈、原文朗读口语、文章相关写作、微型错题复盘、行动型周报和临时离线进度恢复。内容库采用分页渲染，六步流程会自动收起已完成步骤，手机端步骤条、底部安全区和页面滚动已做专项优化。

词库包含 30,000+ 条单词/词组，并导入用户提供的托福、雅思、六级三本词书，由 Oxford、Cambridge、Open English WordNet 与 ECDICT 补充；支持查词、腾讯云发音预载、词义分项、选词书、键盘快捷复习、四档间隔复习、跳过、掌握与移除。语音统一接入腾讯云：每篇文章只缓存一份自然语速完整音频，播放器实时完成 0.75×/1×/1.25× 调速；开始口语录音会强制暂停听力、词典发音与录音回放，并在结束后释放麦克风。智聆口语评测新版（SOE-N）直接对可回听、可重录的真实录音做成人严格声学评分。系统不接入 DeepSeek，也不使用本地口语评分。

## 文档

- [Linux 服务器部署与回滚](docs/SERVER_DEPLOYMENT.md)
- [腾讯云配置、验证与排错](docs/TENCENT_CLOUD_CONFIGURATION.md)
- [2026-08-26 优化实施与复验](docs/RELEASE_OPTIMIZATION_2026-08-26.md)
- [部署门禁、可信 HTTPS 与备份恢复](docs/DEPLOYMENT_AND_RECOVERY.md)
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
npm run word-library:import
npm test
npm run test:ui
npm run build
```

运行数据库位于 `data/ai-english.sqlite`，并被 Git 忽略。`content/lessons.json` 是可审查、可重建的 1000 篇内容基线；`content/crawl-report.json` 和 `content/ingestion-report.json` 保存采集与校验结果。

数据库维护与本地 HTTPS：

```powershell
npm run db:verify
npm run db:backup
npm run db:restore -- --from backups/<backup-file>.sqlite --database data/restore-verified.sqlite
npm run tencent:verify
npm run https:setup
```

腾讯云只需在 `.env.local` 填写 `TENCENTCLOUD_APP_ID`、`TENCENTCLOUD_SECRET_ID` 和 `TENCENTCLOUD_SECRET_KEY`，并在控制台开通语音合成、语音识别和智聆口语评测新版。默认采用英文男声 `101050`、英语 `16k_en` 和成人严格系数 `4.0`。机器翻译 TMT 是可选能力，开通后把 `TENCENT_TMT_ENABLED` 改为 `true`；未开通或调用失败时自动使用规则量表，不影响学习流程。密钥仅由服务端读取，不会发送到浏览器或进入 Git。

完整状态、存储位置、验收结果和外部依赖见[交付文档](docs/AI_ENGLISH_MVP_DELIVERY_STATUS.md)。
