# AIEnglish 优化实施与复验记录

日期：2026-08-26。结论：本轮代码、安全隔离、界面、性能和运维改进已落地，运行服务已更新。可以继续本机/局域网受控试用；**还不能签署“全操作系统、三端真机正式上线通过”**，原因是缺少真实移动设备的录音验收与正式域名部署环境。

## 1. 已实施

| 优先级 | 原问题 | 本轮改动与验证 |
| --- | --- | --- |
| P0 | 离线草稿串到另一账号 | 草稿按不可变 userId 与版本隔离；旧无归属草稿在浏览器隔离保留、不自动恢复到任一账号；退出立即锁定、取消旧请求；跨标签页同步锁定；联网后补撤销离线退出会话。A/B 浏览器场景通过。 |
| P0 | 私人录音退出后仍可从缓存读取 | 录音网络直取、no-store、URL 绑定用户；旧混合缓存迁移删除；SW 只缓存允许的公共合成语音。32,044 字节合成测试 WAV：本人 200、另一用户 403、退出后 401，CacheStorage 无录音。 |
| P0 | 换账号时旧请求仍执行 | 请求有账号头、取消信号、超时；服务端拒绝账号不匹配的读取、保存和旧退出请求；多标签页回归通过。 |
| P0 | 手机批改反馈挤成细列 | 修正 CSS 层叠顺序，反馈单列并自动换行。390px 时正文宽度由 70px 增至 276px；320–1440px 六档无横向溢出。 |
| P0/部署 | HTTP 录音不可用、证书 IP 过期 | 更新证书 SAN；当前 Windows 用户已确认信任本地 CA；启动检查地址漂移；局域网 HTTP 跳 HTTPS；公开 origin、可信代理及安全 Cookie 配置已实现。全新当前用户 Edge 会话不跳过证书校验，回环/局域网 HTTPS 均 200，secureContext 与 mediaDevices 均 true。 |
| P1 | 设置被迟到的初始化覆盖 | 读取完成前禁用控件，失败可重试，离开时取消读取；保存期间禁用设置。延迟响应、保存和重进回归通过。 |
| P1 | 首屏完成步骤展开后再收起 | 初始化即采用完成状态；减少无变化的初始进度写入；三尺寸 CLS 由 0.200/0.276/0.467 降为 0。 |
| P1 | JS/CSS 未压缩、缓存缺失 | Brotli/gzip、压缩去重、有界内存缓存、ETag/304、HEAD；哈希资源 immutable，HTML/SW 重验证，缺失资源正确 404。 |
| P1 | 语音大量并发与长时间等待 | 腾讯仍是实际合成服务；客户端最多两个并发，服务端有界队列、等待超时、503/Retry-After；取消、失败恢复及队列上限测试通过。 |
| P1/P2 | 收藏、查词、复习操作异常 | 增加失败提示、重试、重复点击保护；撤销失败捕获；查词加载态与取消；选择词条防止旧响应覆盖新词条。收藏故障注入后可重试，双击仅一次写入，提示自动消失。 |
| P2 | 移动端隐藏导航仍获键盘焦点 | 关闭时 inert/aria-hidden；打开后聚焦、Tab 循环、Escape 关闭并归还焦点；查词有独立可访问名称。 |
| P2 | 音频对象与录音资源滞留 | Blob URL LRU 有界缓存与回收，离开/退出释放播放与录音资源；麦克风等待期间离开也会释放返回的流；区分解码、自动播放和网络错误。 |
| P2 | WebKit 触屏“继续加载”偶发无效 | 记录到点击落在容器上而按钮已经下移；移动端取消课程行 content-visibility 延迟展开，并修正覆盖它的 CSS layer；六档触屏加载、搜索、切课复验通过。 |
| P2 | 运维与内容风险难以发现 | 增加健康/就绪门禁、requestId 与慢请求日志；安全备份/恢复保护；20 用户混合操作；课程与词库质量审计脚本；部署和回滚说明。 |

前端测试技能指导了真实页面、故障注入与多引擎复验；React 性能规范用于初始化状态、请求取消、避免无效初始写入及资源复用。未改动用户原有的朗读口语设计、移除单词录音的决定、两道文章相关译写或“复习/学新词”入口。

## 2. 测试覆盖与边界

- 环境：Windows 11，Edge、Chrome for Testing、Firefox、Windows WebKit；每次使用新浏览器上下文。手机/平板为 viewport、触屏及移动模式模拟，不冒充 Android/iOS/iPadOS/macOS 真机。
- 桌面 1440×1000、手机 390×844、平板 820×1180 完整流程：注册登录→听力/词音→收藏→理解/翻译→口语入口→单词查词/切书/背词/暂停/刷新→课程筛选→两道译写→总结→复盘→偏好保存→退出。
- Edge、Chrome、Firefox 各 27/27 个流程组通过；运行中未收集到未处理页面异常。
- WebKit 完整流程最终 24/27 个组通过，剩余三组均为音频；非媒体功能及 320/360/390/430/820/1440px 安全/交互复验通过。Windows WebKit 音频解码仍是环境限制：普通音频对照也失败，不能据此宣称真实 Safari 音频通过。详见原始结果和上线待验项。
- `npm test` 12/12 通过；现有 UI 回归通过；新增 release 回归涵盖账号头、离线换号/重新登录、跨标签退出、旧 SW 缓存升级、私人录音、收藏失败与双击、六档批改/设置/导航/切课。
- 原句 `i can walk for ten mini every day.` 被判为错误，反馈包含 `i → I`、`mini → minutes`。
- 腾讯 TTS 两轮各 5 次、共 10 次不同文本真实合成全部成功，均 cacheHit=false。耗时范围 776–1587ms。SOE 配置/签名和录音转换有检查；没有将合成 WAV 或预置 speaking 完成状态视作真实口语评分通过。
- 20 用户混合注册、偏好、收藏、学习进度隔离通过；100 次集中 bootstrap 读取零失败，P50 269ms、P95 507ms、最大 533ms。这是有界测试，不是容量承诺或长时间压测。

## 3. 性能实测

均为本机服务的实验室值；新浏览器上下文，禁浏览器缓存与 SW。下表为三次中位数，当前用户 Edge；慢速场景模拟 150ms 延迟、200KB/s 下行和 CPU 4 倍降速。与前次审计为同类条件，不代表手机硬件实测。

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 桌面首页可见 | 212ms | 191ms |
| 手机尺寸首页可见 | 218ms | 187ms |
| 平板尺寸首页可见 | 200ms | 181ms |
| 弱网手机首页可见 | 3655ms | 2153ms |
| 弱网手机 LCP | 3544ms | 2116ms |
| 首屏传输总量 | 约 381KB | 约 133KB，减少约 65% |
| CLS 桌面/手机/平板 | .200 / .276 / .467 | 0 / 0 / 0 |

优化后的普通场景 TBT 为 0；弱网/CPU 降速场景 TBT 三次约 119–130ms，未把这一项描述为改善。页面切换多为数十毫秒，见原始数据。20 次课程往返后 GC 保留堆约增加 1.02MiB，不能据此断言不存在长期内存泄漏；音频缓存已设置条数/字节上限与 URL 回收。

运行中的正式服务：8 个独立 QA 用户分 5 轮读取，共 40 请求，零失败，P50 105ms、P95 173ms、最大 191ms；总耗时 843ms，CPU 累计增加 0.781s，工作集约 76.9→77.6MiB。性能数据不混同于 20 用户测试。

## 4. 数据、上线条件与残余风险

1. 数据备份与独立恢复验证通过：完整性 ok，schema 9，1000 篇课程；没有覆盖正式学习数据。旧证书和私钥保留了本地副本，没有删除用户资料。
2. 1000 篇课程结构、两道译写相似度及难度规则检查通过，不代表对所有拓展文章做过人工语义审核。
3. 三本考试词书音标缺失均为 0；仍有 61/11/44 条无例句（六级/雅思/托福），系统已有缺例句时转为拼写题的处理。总库 30,614 条中仍有 10,894 条无音标（含大量词组）与 18,140 条无例句。新增审计会显式报告，不以生成的未核实内容填充。
4. **公开上线阻塞：**尚无真实域名/DNS/公网证书部署；Caddy 与环境配置模板已提供，未进行外部发布。当前 `/api/ready` 因没有 PUBLIC_ORIGIN 按预期返回 503。
5. **三端真机验收阻塞：**真实 Android、iOS/iPadOS Safari、macOS Safari 的麦克风许可、真实朗读评分、上一次录音回听及前后台切换尚需设备实测。本机根证书信任不会传播到其他设备。
6. 本次没有执行长时间 soak test、攻击性压测或付费云真机服务，也没有把短测成功写成稳定性保证。

操作说明：[部署与恢复](./DEPLOYMENT_AND_RECOVERY.md)。上述外部条件满足并复测后再将上线结论改为 Go。

## 5. 复现与证据

- [原上线审计](D:/PG_Temp/ai-english-release-20260826/AIEnglish-上线验收报告-2026-08-26.md)
- [Edge 完整流程](D:/PG_Temp/ai-english-optimized-20260826/production-results.json)、[Chrome](D:/PG_Temp/ai-english-optimized-20260826/chrome-results.json)、[Firefox](D:/PG_Temp/ai-english-optimized-20260826/firefox-results.json)、[WebKit](D:/PG_Temp/ai-english-optimized-20260826/webkit-results.json)
- [性能与可信 HTTPS](D:/PG_Temp/ai-english-optimized-20260826/performance-results.json)、[服务资源和延迟](D:/PG_Temp/ai-english-optimized-20260826/load-results.json)、[课程检查](D:/PG_Temp/ai-english-optimized-20260826/content-validation.json)
- [WebKit 安全与六档交互](D:/PG_Temp/ai-english-release-RDL3EC/results.json)、[Chrome 安全回归](D:/PG_Temp/ai-english-release-u4ZpHW/results.json)、[Firefox 安全回归](D:/PG_Temp/ai-english-release-ZlFL50/results.json)
- [Edge 最终交互回归](D:/PG_Temp/ai-english-release-KN20Xv/results.json)
- [旧草稿隔离保留后的最终回归](D:/PG_Temp/ai-english-release-c2smfr/results.json)
- [390px 批改修复截图](D:/PG_Temp/ai-english-release-RDL3EC/writing-390.png)

长期保留的自动化入口为仓库内 `tests/release.test.mjs`、`tests/http-policy.test.mjs`、`tests/concurrency.test.mjs`、`tests/multi-user.test.mjs`。临时证据目录未包含真实用户密码或录音，隔离用的 WAV 为合成测试数据。
