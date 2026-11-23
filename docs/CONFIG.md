# 说明与排查

## 事件从哪来

`session/event` 是 DSH 会话事件流（`@deepseek-ai/dsh-session`），每个事件形如：

```js
{ seq, time, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
```

插件只读这些字段：

| 事件 | 用途 |
|---|---|
| `session/title` | 通知标题（取 `data.title`） |
| `turn/start` | 记本轮起点、清空缓存 |
| `assistant/message` | 累积 `data.message.content` 里 `type: 'text'` 的块 |
| `tool/call` | 统计本轮工具调用次数 |
| `turn/end` | 触发通知，读 `data.reason.kind`（`completed` / `aborted` / `error` / `blocked` / `interrupted`） |

子代理会话通过 `session.header.parentSessionId` / `parentAgentId` 识别，默认不通知。

## 推送服务实现（host 侧 `notify.js`）

| 服务 | 端点 | 备注 |
|---|---|---|
| wecom-robot | `POST {wecomApiBase}/cgi-bin/webhook/send?key=` | `wecomApiBase` 可指向自建 mock，便于测试 |
| wecom-app | `GET /cgi-bin/gettoken` → `POST /cgi-bin/message/send` | access_token 缓存至过期前 1 分钟 |
| dingtalk | `POST /robot/send?access_token=&timestamp=&sign=` | sign = base64(HmacSHA256(secret, timestamp + '\n' + secret))，再 urlEncode |
| telegram | `POST /bot<token>/sendMessage` | 429/5xx 视为可重试 |
| email | SMTP | 465 隐式 TLS / 587 STARTTLS；AUTH LOGIN 失败回落 PLAIN；正文 base64 |
| webhook | 任意 URL | 默认 JSON，`{{text}}/{{title}}/{{session}}/{{project}}/{{level}}/{{time}}` 占位 |

配置优先级：**面板保存的 `settings.json` > patch 里的 `config`**。密钥字段面板只回显 `***`。

## 为什么按字节分段

企业微信群机器人：`text` 单条 **2048 字节**、`markdown` 单条 **4096 字节**，超了会被截断（不报错）。
中文 UTF-8 一个字 3 字节，所以 600 多字就爆。插件按 1800 字节打包、优先在换行切，
单行仍然超长时按 Unicode 码点切（不会切坏多字节字符），并给每段加 `[i/n]` 前缀。

`maxChars`（默认 6000）是另一层保险：一轮输出几十 KB 时只发前 6000 字符并标「已截断」，
避免一次刷出几十条消息。想全量发就把 `maxChars` 调大。

## 限流

群机器人上限约 20 条/分钟，`minGapMs: 3200` 就是贴着这条线走的。
多段消息会排队依次发出（4 段约 10 秒）。返回 `errcode 45009` 视为可重试，按 3s→6s→12s… 退避（封顶 60s，最多 `maxRetries` 次）。

## 会话级开关怎么落盘

`queueDir` 下的 `sessions.json`：

```json
{
  "defaultEnabled": true,
  "sessions": {
    "session-aaaa1111": { "enabled": false, "title": "CMS 扫描", "cwd": "D:/aiwork/cms", "updatedAt": 1764000000000 }
  }
}
```

判定：会话有显式记录 → 用它；没有 → 用 `defaultEnabled`。界面按钮每 15 秒轮询一次 `/ctl/state`，点击走 `POST /ctl/toggle`。

## 出问题先看这几处

| 现象 | 排查 |
|---|---|
| 手机没收到 | `C:/Users/<你>/.dsh/profiles/<profile>/logs` 里搜 `[wecom-notify]`：没有这行 = 插件没加载（bundle 没注册/没重启）；有 `缺少 webhookUrl` = key 没配到 |
| 报 `errcode 93000` | key 无效或机器人被移除 |
| 报 `errcode 45009` | 触发限流，插件会自动退避重试 |
| 消息只有一半 | 你用的是 v0.1/v0.2，升级到 0.5.0（自动分段） |
| 界面没有胶囊 | 浏览器 console 搜 `[dsh-wecom-notify]`；确认 `dsh.client` 段和 `./client` 导出都在 package.json 里，且重启过 DSH |
| 胶囊显示「离线」 | 8791 被占用或被防火墙拦；换 `controlPort` 或看 Host 日志的「控制接口启动失败」 |

## 卸载

1. profile 的 `cordis.patch.yml` 删掉 `wecom-notify` 那条覆盖，`package.json` 的 dependencies / bundles 删掉对应项
2. 删掉 `node_modules/dsh-wecom-notify`（junction 或目录）
3. 重启 DSH

## 以后想做双向（可选路线）

发送层与事件层是解耦的：把 `webhookUrl` 指向自建中继，把 `send()` 的 payload 换成中继协议即可。
接收方向需要「中继 → 本机 HTTP → 注入一条 user 消息」，那是另一期的事，插件的事件监听部分不用动。