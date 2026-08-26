# 腾讯云配置说明

AIEnglish 的文章朗读、单词发音、语音识别和口语评分由服务器调用腾讯云。浏览器不持有 SecretId、SecretKey，也不使用系统朗读冒充腾讯语音。

## 本次服务器实测状态（2026-08-26）

- 配置已通过 SSH 放入服务器受限文件，未提交 GitHub。
- TTS：两批不同文本共 **10/10 成功**，均为腾讯 TextToVoice、音色 101050、未命中缓存；耗时 758–1474 ms。
- 用户开通新版口语评测后，ASR / SOE-N 连续三轮真实调用均成功。ASR 使用 `16k_en`，538–766 ms；原实时模式下短音频 SOE-N 为 8540–8578 ms，第三轮额外校验了声学评分、模型、各评分字段和返回转写。
- **此前 SOE-N 4003 未开通问题已解决。**无需再次开通或更换密钥。新环境若再遇到该错误，检查对应 AppID 的[新版口语评测控制台](https://console.cloud.tencent.com/soenew)及[官方错误码说明](https://cloud.tencent.com/document/product/1774/107497)。本次未代用户购买资源包或变更密钥。
- 通过实际公网 `https://cayi-ai.top:20057`，已完成一段 **64.296 秒、2,057,550 字节 WAV** 的上传 → 腾讯评分 → 读取上次录音检查；JSON 请求 2,743,504 字节。优化前评分请求 37,118 ms；`7d176ea` 改用腾讯录音模式后，三轮完整公网评分请求为 **15,700 / 16,742 / 16,483 ms**，中位数减少约 **56%**。每轮回听均与上传音频逐字节相同，下载 67–88 ms。
- 上线前候选容器直接评测同一音频三轮：15,161 / 14,951 / 15,625 ms。以上共六轮均成功，均为真实 `tencent-soe` 声学评分、成人严格度 4.0；分段保持 35.90425 秒 / 84 词与 28.39175 秒 / 71 词。六轮评分字段一致（总分 82、精准度 83、流利度 97、完整度 95），未改变及格条件。公网时间包含上传；实际手机弱网、录音长短及腾讯负载仍会影响延迟。
- 短音频连通性诊断不写数据库；长音频端到端测试仅写入 `WAN_QA_` 专用测试账号。全部使用明确标记的合成音频，**不代表真人发音质量或手机/平板麦克风验收**。
- Nginx 已放宽为 `client_max_body_size 16m`，评分上游等待 360 秒，客户端评分请求等待 420 秒。系统仍限制录音最长 5 分钟，不是无限制上传。

## 1. 开通哪些服务

| 服务 | 应用内用途 | 是否必需 |
| --- | --- | --- |
| 语音合成 TTS / TextToVoice | 听力全文、单词与例句发音 | 必需 |
| 语音识别 ASR / SentenceRecognition | 真实录音转写 | 必需 |
| 智聆口语评测**新版** SOE-N | 原文朗读的声学评分 | 必需；不要只开通旧版 SOE |
| 机器翻译 TMT | 为整段翻译提供可选参考 | 可选，默认关闭；不影响两道写作翻译的严格拼写检查 |

在所属腾讯云账号开通上述产品，并检查余额、资源包与调用权限。AppID、SecretId、SecretKey 必须属于有服务权限的同一账号体系。建议使用专用 CAM 子用户和最小必要调用权限，不使用共享主账号密钥；具体权限按产品支持范围配置。[TTS 接口说明](https://cloud.tencent.com/document/api/1073/37995)、[TTS 访问管理](https://cloud.tencent.com/document/product/1073/95482)、[SOE-N 接口及开通要求](https://cloud.tencent.com/document/product/1774/107497)。

## 2. 配置放在哪里

本机：项目根目录 `.env.local`。本次 Linux Docker 部署：`/home/ansible/ai-english/runtime.env`，只读挂载为容器内 `/app/.env.local`，文件权限 `600`。不要将此文件提交 Git、放入镜像、发送给前端或贴到聊天中。

```dotenv
TENCENTCLOUD_APP_ID=填写腾讯云AppID
TENCENTCLOUD_SECRET_ID=填写专用密钥SecretId
TENCENTCLOUD_SECRET_KEY=填写专用密钥SecretKey
TENCENTCLOUD_REGION=ap-guangzhou
TENCENT_TTS_VOICE_TYPE=101050
TENCENT_TTS_MODEL_TYPE=1
TENCENT_TTS_CONCURRENCY=2
TENCENT_API_ATTEMPTS=3
TENCENT_API_TIMEOUT_MS=20000
TENCENT_ASR_ENGINE=16k_en
TENCENT_SOE_SCORE_COEFF=4.0
TENCENT_SOE_CONCURRENCY=4
TENCENT_TMT_ENABLED=false
```

这些是应用当前默认值，不是腾讯云账号额度承诺。TTS 并行数建议先维持 2；升高之前先确认账号并发配额和实际延迟。文章只合成一份正常语速音频，0.75×、1×、1.25×由播放器调整，不会为每档反复计费。

已完成的录音使用 SOE-N `rec_mode=1`：每个连接一次发送一段完整 PCM，不再按原速播放一遍后才完成上传。腾讯限制每段不超过 60 秒、一次二进制音频；应用保留每段不超过 118 个英文词，长段按约 50 秒目标重新切分并对齐附近静音点，保存全部音频和参考文本。极端不可分割的单词长录音保留官方实时模式及其原速发送要求，不向录音模式强发超限片段。服务合同见[录音模式说明](https://cloud.tencent.com/document/product/1774/107372)与[接口参数/传输限制](https://cloud.tencent.com/document/product/1774/107497)。

SOE 连接默认全应用共享 4 个并行名额（配置范围 1–8），排队有容量和等待上限，拥塞时返回可重试提示。不会因每个用户独立开无限连接而耗尽配额；但有限资源下的排队时间仍会增加。连接未收到最终评分就关闭时立即失败，不再拿到中间结果后一直等到超时。

应用使用 FFmpeg 将录音转为 16 kHz、16-bit、单声道，再向 SOE-N 发送；浏览器必须在可信 HTTPS 下获得麦克风权限。服务器需能出站访问 `tts.tencentcloudapi.com:443`、`asr.tencentcloudapi.com:443`、`soe.cloud.tencent.com:443`；启用 TMT 时还需 `tmt.tencentcloudapi.com:443`。服务器时钟需同步，否则签名可能过期。SOE-N 音频要求见[官方接口文档](https://cloud.tencent.com/document/product/1774/107497)。

## 3. 修改、重启与验证

```bash
cd /home/ansible/ai-english
chmod 600 runtime.env
# 修改 runtime.env 后重启，使进程重新读取配置。
sudo docker compose --env-file deployment.env restart app
# 仅校验字段及 SOE-N 签名生成，不代表腾讯服务实调成功。
sudo docker exec ai-english node scripts/verify-tencent.mjs --config-only
# 5 次不同文本，强制产生新的真实 TTS 请求；会消耗少量语音额度。
sudo docker exec ai-english node scripts/verify-tencent.mjs --runs=5
```

通过标准：每次返回 `ok: true`、`provider: tencent`、有效音频字节，且新文本 `cacheHit: false`。再从页面分别播放完整文章和单词，最后用真人录音提交口语、回听上次录音。TTS 连续成功不能替代 ASR/SOE-N 的真人评分验收。

`/api/health` 只表示服务进程/数据库正常；`/api/ready` 额外检查构建、腾讯配置、HTTPS origin，**不代表腾讯账号实时可用**。修改密钥后应重跑实调。

## 4. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| AppIdNotRegistered、账号未开通 | 检查 TTS、ASR、SOE-N 是否分别开通；新版评测与旧版不能混淆 |
| AuthFailure、签名失败 | 三个标识是否匹配、SecretKey 是否完整、有无空格/引号、服务器时间是否准确 |
| 超时、限流、额度不足 | 查看腾讯控制台余额/配额；检查服务器出站网络，保留默认并发和有界重试 |
| 听力能播，口语不能录 | 检查 HTTPS 证书、浏览器权限和麦克风；这是浏览器录音前置条件 |
| 录音上传返回 413 | 反向代理 body 大小不足；本次服务器已应用 `client_max_body_size 16m`。录音以 Base64 JSON 上传会膨胀约三分之一，应用仍会校验文件大小与最长 5 分钟时长 |
| 评分等待接近录音长度 | 确认已部署 `7d176ea` 或后续版本；已完成录音应使用 `rec_mode=1`，避免实时流按原速重发。当前同一 64 秒样本公网约 16 秒，不能承诺任意长度或弱网下即时返回 |
| 长录音已上传但页面先报超时 | 核对代理与客户端超时；当前客户端评分 420 秒、Nginx 上游读取 360 秒，保留弱网上传及特殊实时回退余量。普通接口仍保留原超时，评分不自动重复提交 |
| 手机能打开页面，但登录提示网络连接失败 | 旧浏览器可能不支持 `AbortSignal.any/timeout/throwIfAborted`。`7d176ea` 已改用兼容实现，关闭旧页面后重新打开正确公网地址；若仍失败，记录手机系统、浏览器版本、网络类型和发生时间，不要直接删除未同步学习草稿 |
| 公网能打开页面，注册/收藏返回来源不受信任 | `PUBLIC_ORIGIN` 必须填写浏览器实际公网地址 `https://cayi-ai.top:20057`，不是内网监听端口 8443 |
| 配置文件改了但行为未变 | 重启应用；进程环境变量优先于 `.env.local`；不要同时维护两份冲突密钥 |

发生疑似泄露时在腾讯云撤销旧密钥并生成新密钥，更新服务器受限文件、重启并复验；不要通过 Git 历史保存密钥备份。用量、套餐和价格以腾讯控制台当前信息为准。
