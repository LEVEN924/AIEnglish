# 腾讯云配置说明

AIEnglish 的文章朗读、单词发音、语音识别和口语评分由服务器调用腾讯云。浏览器不持有 SecretId、SecretKey，也不使用系统朗读冒充腾讯语音。

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
TENCENT_TMT_ENABLED=false
```

这些是应用当前默认值，不是腾讯云账号额度承诺。TTS 并行数建议先维持 2；升高之前先确认账号并发配额和实际延迟。文章只合成一份正常语速音频，0.75×、1×、1.25×由播放器调整，不会为每档反复计费。

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
| 录音上传返回 413 | 反向代理 body 大小不足；配置 `client_max_body_size 16m`，应用仍会校验请求大小 |
| 配置文件改了但行为未变 | 重启应用；进程环境变量优先于 `.env.local`；不要同时维护两份冲突密钥 |

发生疑似泄露时在腾讯云撤销旧密钥并生成新密钥，更新服务器受限文件、重启并复验；不要通过 Git 历史保存密钥备份。用量、套餐和价格以腾讯控制台当前信息为准。
