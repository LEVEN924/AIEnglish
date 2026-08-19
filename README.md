# AIEnglish

AIEnglish（Ink & Air）是一款个人每日英语学习应用。它以档案馆编辑风格把每篇内容组织成导读、听力、翻译、口语、写作和总结六步连续学习流程。

## 当前版本

- 50 篇 L1/L2/L3 精选内容，来源与质量记录完整。
- SQLite 保存内容、账号、会话、学习进度、作答版本、评分、错题与总结。
- 电脑和手机通过同一局域网服务共享学习状态。
- 本地量表评分默认可用，可选 OpenAI 结构化批改。
- 响应式桌面/手机 UI、PWA 应用壳、一键启动与关闭。

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

运行数据库位于 `data/ai-english.sqlite`，并被 Git 忽略。`content/lessons.json` 是可审查、可重建的 50 篇内容种子。
