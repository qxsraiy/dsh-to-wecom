# dsh-to-wecom

把 **DeepSeek Harness（DSH）** 每一轮 AI 输出结束后的摘要，推送到你选的通道：**企业微信群机器人 / 企业微信应用消息 / 钉钉机器人 / Telegram / 邮件 / 自定义 webhook**。

只出站、单向、无需服务器：不需要企业微信自建应用、不需要「企业可信 IP」、不需要回调域名。

```
DSH Host 插件 ──(turn/end 事件)──► 组包 + 分段 + 队列 ──HTTPS──► qyapi.weixin.qq.com
                                                                          │
                                                                    手机企业微信/微信
```

## 特性

- **每轮一条**：挂 `session/event` 的 `turn/end`，不改模型上下文、不打扰推理
- **纯文本**：默认 `msgtype=text`，微信里不会出现 markdown 源码；想带颜色可切 `markdown`
- **超长自动分段**：企业微信 text 上限 2048 字节，插件按 1800 字节一条、优先在换行处切，标 `[1/3]`
- **整轮内容**：汇总本轮所有 assistant 输出（多步也拼上），保留原换行，默认不截断
- **队列 + 重试**：内存队列 + 串行闸门 + 指数退避，失败落盘 `pending.jsonl`，重启补发；限流 3.2s/条贴着 20 条/分钟
- **多通道**：6 种推送服务，在插件设置页里选一种、填对应表单即可，一行配置切换
- **会话级开关**：会话头部**右上角**一枚小按钮，只管当前会话，按 `sessionId` 开关（同一目录的不同会话互不影响），**默认关闭**，要哪个自己开
- **无额外端口**：界面与 Host 走 DSH 自己的同源 `/api/dsh-to-wecom`（`ctx.connection.fetch` 精确路由 + cookie 认证），不再起本地 HTTP 服务
- **零依赖**：只用 Node 内置模块（`node:http` / `node:fs` / 全局 `fetch`）

## 通知长什么样

```
【完成】渗透报告整理
任务 #abcd · 第 3 轮 · 42s · 工具 24 次
目录 D:/aiwork/cms

报告已生成，共 12 个目标，3 个高危；文件落在 D:/aiwork/cms/report.md。
```

失败会变成 `【失败 (UNKNOWN)】` 并多一行错误信息：

```
【失败 (UNKNOWN)】渗透报告整理
任务 #abcd · 第 4 轮 · 12s · 工具 0 次
目录 D:/aiwork/cms
错误 connect ETIMEDOUT 10.0.0.9:443
```

## 部署（三步）

```bash
git clone https://github.com/qxsraiy/dsh-to-wecom.git && cd dsh-to-wecom
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
# macOS / Linux
sh scripts/install.sh
```

然后**完全退出 DSH 再启动** → 设置 → 插件 → **通知推送** 填自己的凭据 → 「发送测试」。

插件的凭据、profile 位置、手工安装步骤、升级、卸载、排错，全在 **[docs/INSTALL.md](docs/INSTALL.md)**。

脚本做的事（等价手工操作）：在 `<profile>/node_modules` 建一个指向本仓库的链接，并在 `<profile>/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里登记 `dsh-wecom-notify`（写前备份 `.bak-dsh-to-wecom`）。

## 配置

改 **profile 的 `cordis.patch.yml`**（不要改本仓库里的 `cordis.patch.yml`，避免把密钥提交上去）：

```yaml
- id: wecom-notify
  name: 'dsh-wecom-notify'
  config:
    enabled: true
    provider: wecom-robot
    wecomKey: '你的群机器人 key'
    format: text            # text | markdown
    notifyOn: every-turn    # every-turn | completed | errors-only
    includeSubagents: false
    minGapMs: 3200
    textLimit: 0            # 0=不截断
    maxChars: 6000
    controlPort: 8791
```

或者干脆把 key 放进环境变量 `WECOM_ROBOT_KEY`，仓库里保持空值。

> 本仓库不含任何真实凭据；`npm run check:secrets` 可自检，详见 [SECURITY.md](SECURITY.md)。

## 把插件分享给别人

1. 对方 clone 本仓库，按「安装」把目录加成 bundle（或 `dsh plugin add file:<路径>`）；
2. 重启 DSH，设置 → 插件 → **通知推送**：选服务、填自己的凭据、点「发送测试」；
3. 到要收通知的会话，点头部右上角 `🔔 推送关` 变绿即可。

凭据只落在对方本机的 `settings.json` / profile patch，不会回到仓库。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `webhookKey` | `''` | 群机器人 key；空则读 `WECOM_ROBOT_KEY` |
| `webhookUrl` | `''` | 直接给完整 URL（优先于 key，测试/自建中继用） |
| `format` | `text` | `text` 纯文本 / `markdown` 带颜色 |
| `notifyOn` | `every-turn` | `completed` 只发成功 / `errors-only` 只发失败 |
| `includeSubagents` | `false` | 子代理会话是否也通知 |
| `minGapMs` | `3200` | 两条之间的最小间隔 |
| `textLimit` | `0` | >0 时按字符截断摘要 |
| `maxChars` | `6000` | 单条总字符上限，超出标「已截断」 |
| `maxRetries` | `5` | 失败重试次数（3s→60s 退避） |
| `queueDir` | `''` | 队列/偏好目录，空则用 `process.cwd()` |
| `controlPort` | `8791` | 本机控制接口端口（只绑 127.0.0.1） |
| `dryRun` | `false` | 只打日志不发送 |

## 界面开关（会话级，右上角）

会话头部**右上角**一枚小按钮（默认关闭）：

```
                              ● 🔔 推送关
```

- **只管当前会话**：点一下切换这个会话，没有下拉、没有面板
- 绿点=开，灰点=关；悬停显示会话标题与 ID
- Host 不在线时红点 + `通知离线`，禁用点击
- 默认 `defaultEnabled: false` —— **不主动打扰，用哪个会话点哪个**

## 推送服务配置（插件设置页）

设置 → 插件 → **通知推送** 标签页：第一行选推送服务，下面自动换成对应表单，填完点「保存」，可点「发送测试」立刻验证。

| 服务 | 需要的字段 | 说明 |
|---|---|---|
| 企业微信群机器人（推荐） | `wecomKey` | Webhook 里 `key=` 后面那串，最简单，不需要可信 IP |
| 企业微信应用消息 | `wecomCorpId`、`wecomSecret`、`wecomAgentId`、`wecomToUser` | 走 `gettoken` + `message/send`，需要企业微信后台配置**企业可信 IP** |
| 钉钉群机器人 | `dingToken`、`dingSecret`（可选） | 支持加签（HmacSHA256 + timestamp） |
| Telegram | `telegramToken`、`telegramChatId`（必填）、`telegramUserId`、`proxyUrl` | 每个 DSH 会话自动建一个**话题（topic）**，全文发进对应话题；支持 HTTP 代理（CONNECT 隧道） |
| 邮件 | `mailHost`、`mailPort`、`mailUser`、`mailPass`、`mailFrom`、`mailTo` | 内置最小 SMTP 客户端：465 直连 TLS，587 走 STARTTLS，AUTH LOGIN/PLAIN |
| 自定义 Webhook | `webhookUrl`、`webhookAuth`（可选）、`webhookTemplate`（可选） | 默认 POST `{text,title,session,project,level,time}`；模板支持 `{{text}}` 等占位符 |

密钥字段回显为 `***`，留空或保持 `***` 不会覆盖原值。配置保存在 `queueDir/settings.json`，**不会**写进仓库。

### 双通道：TG 全文 + 企微简报

设置页里有「镜像通道」：主通道（如 Telegram）发全文并落到该会话自己的话题里，
镜像通道（如企业微信群机器人）只发一句 `[#8f3a] CMS 扫描 · 完成（详情见 TG）`。

```json
{ "provider": "telegram", "mirror": "wecom-robot", "wecomKey": "你的 key" }
```

镜像失败不影响主通道；主通道失败会抛错并按退避重试。

## 在 Telegram 里指挥（入站控制）

配好 token + chat_id 后，插件会**长轮询** `getUpdates`（出站，无需公网回调）：

- 每个会话对应群里一个**话题**，你在哪个话题说话，就投给哪个会话
- 普通文字 → 该会话**开新一轮**（`agent.followup`）
- `! 补充指令` → 纠偏**正在执行**的 turn（`agent.steer`）
- `/tasks` 列会话（编号 + 短号 + 标题）；`/use 2` 或 `/use 8f3a` 改绑定
- `/status` 看当前绑定与运行状态；`/stop` 中断当前会话
- `/rename 新标题` 直接改 DSH 会话名，TG 话题名会自动跟着变
- `telegramUserId` 填了就等于白名单：其他人发什么都不理

## 测试

```bash
npm run test:chunk     # 假 webhook：验证整轮内容 + 超长自动分段
npm run test:control   # 同目录双会话：验证按会话静音互不影响
npm run test:send -- <key>   # 往真实群机器人发一条测试
```

`test:chunk` 期望输出 `parts=4 … complete=true -> PASS`；`test:control` 期望 `received = 2 · PASS`。

## 工作原理

- 事件：`ctx.on('session/event')` 观察 `turn/start`、`assistant/message`、`tool/call`、`session/title`、`turn/end`
- 组包：会话标题 + 任务短号 + 轮次 + 耗时 + 工具次数 + 目录 +（失败时）错误 + 本轮文本
- 分段：按 UTF-8 字节打包（markdown 3800 / text 1800），单行超限再按码点切，绝不切坏多字节字符
- 发送：串行队列 + `minGapMs` 闸门 + 指数退避；`errcode 45009`（限流）视为可重试
- 界面：`dsh.client` 注册 `conversation.input.dock` 插槽，React 组件轮询本机控制接口

## 兼容性

- DSH `0.2.1-alpha.1` 上实测（profile `desktop`），依赖其 `session/event`、`ctx.slots` 契约
- Node 22+（用全局 `fetch`、`AbortSignal.timeout`）

## License

MIT © qxsraiy