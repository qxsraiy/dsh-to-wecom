# 安全说明

## 仓库里不放凭据

本仓库只包含代码与占位符。任何真实凭据（企业微信 key、企业微信 Secret、钉钉 token、Telegram bot token、SMTP 密码、webhook 鉴权头）都应该放在下面两处之一：

1. **插件设置页**（设置 → 插件 → 通知推送）：写进 `queueDir/settings.json`，本地文件，不进 Git；
2. **profile 的 `cordis.patch.yml`**：写在你自己的 DSH profile 里，不在本仓库内。

`settings.json` 与 `data/` 已在 `.gitignore` 中。

## 提交前自检

```bash
npm run check:secrets
```

`scripts/check-secrets.mjs` 会扫出 UUID 形状的企业微信 key、`<数字>:<长串>` 形状的 Telegram token、`access_token=` 长 hex、带 key 的 webhook URL、硬编码 `Bearer`，命中即退出码 1。建议挂成 pre-commit hook：

```bash
printf '#!/bin/sh\nnode scripts/check-secrets.mjs . || exit 1\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## 密钥一旦暴露怎么办

- 企业微信群机器人：群设置 → 群机器人 → 移除该机器人并重新添加，旧 key 立即失效；
- 企业微信应用：后台重置 Secret；
- 钉钉机器人：重置加签 Secret / 重新生成 access_token；
- Telegram：找 @BotFather `/revoke`；
- SMTP：改邮箱的「授权码」，不要用登录密码。

## 权限边界

- 插件只做出站 HTTPS/SMTP，不监听公网端口；
- 本机控制接口 `127.0.0.1:8791` 只绑回环，带 CORS `*` 是为了让本地 Web UI 调得到，**不要**把它转发到公网（可通过 `controlEnabled: false` 关闭）；
- 通知正文来自会话输出，可能含你机器的路径、命令、代码片段，选通道时注意接收方是谁。
