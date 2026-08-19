# AIEnglish
每日英语app，实现每天推送一篇英语短文（100多个单词左右），用长对话交互的形式，每篇一个对话，对话用成绩+主题命名。事先收录近十年内的文章材料，如BBC、TED、新闻、英语场景、精选外刊、各种话题如职场、心理、社会或其他，有如下环节口语、原文、翻译、写作等。

## 当前状态

项目已完成可运行的局域网体验版 MVP，包含本地登录、5 篇种子内容、每日六步学习流程、档案馆编辑风格 UI、跳过文章、学习记录、一键启停和手机同 Wi-Fi 访问。

## 文档

- [产品、内容与 UI 方案](docs/AI_ENGLISH_APP_PRODUCT_UI_PLAN.md)
- [MVP 交付与当前状态说明](docs/AI_ENGLISH_MVP_DELIVERY_STATUS.md)

## 本地运行

- Windows：双击 `一键打开AIEnglish.cmd`，关闭时双击 `一键关闭AIEnglish.cmd`。
- 命令行：运行 `npm run dev`。
- 本机地址：`http://127.0.0.1:4173/`。
- 手机地址：启动脚本会自动显示当前局域网 IPv4 地址和端口 `4173`，手机与电脑需在同一 Wi-Fi。

## 验证

- `npm test`：运行登录与会话 API 集成测试。
- `npm run content:validate`：校验内容结构、质量和重复项。
- `npm run build`：运行 TypeScript 检查并生成生产构建。
