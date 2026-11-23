# dsh-to-wecom

把 **DeepSeek Harness（DSH）** 每一轮 AI 输出结束后的摘要，推送到 **企业微信群机器人**，微信/企业微信都能直接看。

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
- **会话级开关**：输入区**右下角**一枚小按钮，只管当前会话，按 `sessionId` 静音（同一目录的不同会话互不影响）
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

## 安装

### 方式 A：装进 profile（推荐）

```bash
# 以本仓库目录作为插件包
dsh plugin --profile desktop add "file:D:/path/to/dsh-to-wecom"
```

然后把它加进 profile 的 bundle 列表（`$DSH_HOME/profiles/<profile>/package.json`）：

```json
"dsh": { "profile": { "bundles": ["...", "dsh-wecom-notify"] } }
```

重启 DSH（新 bundle 只在启动时组合）。

### 方式 B：本地目录 junction（开发/自己用最省事）

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-wecom-notify" `
  -Target "D:\path\to\dsh-to-wecom"
```

再改 profile 的 `package.json`（dependencies 加 `"dsh-wecom-notify": "link:D:/path/to/dsh-to-wecom"`，bundles 加同名项）。

## 配置

改 **profile 的 `cordis.patch.yml`**（不要改本仓库里的 `cordis.patch.yml`，避免把密钥提交上去）：

```yaml
- id: wecom-notify
  name: 'dsh-wecom-notify'
  config:
    enabled: true
    webhookKey: '你的群机器人 key'
    format: text            # text | markdown
    notifyOn: every-turn    # every-turn | completed | errors-only
    includeSubagents: false
    minGapMs: 3200
    textLimit: 0            # 0=不截断
    maxChars: 6000
    controlPort: 8791
```

或者干脆把 key 放进环境变量 `WECOM_ROBOT_KEY`，仓库里保持空值。

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

## 界面开关（会话级，右下角）

输入区**右下角**一枚小按钮，不占中间位置：

```
                        ● 🔔 推送开
```

- **只管当前会话**：点一下就切换这个会话的推送，没有下拉、没有面板
- 绿点=开，灰点=关；鼠标悬停显示会话标题、会话 ID、以及点了会怎样
- Host 不在线时变成红点 + `🔔 通知离线`，禁用点击
- 取不到当前会话 ID 时按钮置灰并提示

开关状态存在 `data/sessions.json`（`queueDir` 下），按 `sessionId` 记录；同一 cwd 的不同会话互不影响。

控制接口（界面就是调它，只绑 `127.0.0.1`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ctl/state?session=<id>` | 全部会话 + 当前会话有效状态 |
| POST | `/ctl/toggle` `{sessionId}` | 翻转某会话 |
| POST | `/ctl/set` `{sessionId, enabled}` | 显式设置 |
| POST | `/ctl/reset` `{sessionId}` | 清掉覆盖，回到默认 |
| POST | `/ctl/default` `{enabled}` | 改默认 |

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