# 部署指南（别人拿到这个仓库后怎么用）

这个仓库是**一个 DSH 插件包**，没有构建步骤、没有 npm 依赖（只用 Node 内置模块）。
部署 = 把这个目录接进某个 DSH profile，然后重启 DSH。

## 0. 前置条件

| 项 | 要求 | 怎么确认 |
|---|---|---|
| DSH | 0.2.1-alpha.1 或兼容版本（提供 `session/event`、`ctx.slots`） | 启动 DSH，界面能正常开会话 |
| Node | 22 或更高（用全局 `fetch`、`AbortSignal.timeout`） | `node -v` |
| Git | 用来 clone / 更新 | `git --version` |
| 一个推送通道 | 企业微信群机器人 key（最省事）／钉钉／Telegram／SMTP／自定义 webhook | 见 README 的「推送服务配置」 |

> 不需要 Docker、不需要服务器、不需要企业微信自建应用（除非你选「企业微信应用消息」那条路，它才需要后台配企业可信 IP）。

## 1. 拿到代码

```bash
git clone https://github.com/qxsraiy/dsh-to-wecom.git
cd dsh-to-wecom
```

## 2. 接进 profile

### Windows（一键）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
# 默认 profile=desktop；换 profile：-Profile web
# 只看会做什么、不落盘：-DryRun
```

### macOS / Linux（一键）

```bash
sh scripts/install.sh          # 默认 profile=desktop
sh scripts/install.sh web      # 指定 profile 名
```

### 手工（脚本失败时照这个做）

1. 找到 profile 目录：`$DSH_HOME/profiles/<名字>`（Windows 默认 `C:\Users\<你>\.dsh\profiles\desktop`）
2. 建链接：
   - Windows：`New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-wecom-notify" -Target "<仓库绝对路径>"`
   - macOS/Linux：`ln -s <仓库绝对路径> <profile>/node_modules/dsh-wecom-notify`
3. 编辑 `<profile>/package.json`：
   - `dependencies` 加 `"dsh-wecom-notify": "link:<仓库绝对路径>"`
   - `dsh.profile.bundles` 数组末尾加 `"dsh-wecom-notify"`
4. 保存（脚本会自动备份成 `package.json.bak-dsh-to-wecom`）

## 3. 重启 DSH

新 bundle 只在**启动时**组合：完全退出（Windows 连托盘一起退）再打开。

## 4. 配推送通道

设置 → 插件 → **通知推送**：

1. 第一行选服务（企业微信群机器人 / 企业微信应用消息 / 钉钉 / Telegram / 邮件 / 自定义 webhook）
2. 下面自动换成对应表单，填自己的凭据
3. 点「保存」，再点「发送测试」，手机/邮箱应收到 `[DSH] 测试通知`

凭据存在 `queueDir/settings.json`（默认 `process.cwd()/.dsh-wecom-notify`，profile 里配了 `queueDir` 就按那个走），与仓库无关。

## 5. 开启会话通知

打开要收通知的会话 → 标题**右上角** `🔔 推送关` → 点一下变绿点 `推送开`。
默认**全关**，哪个会话需要就开哪个。

## 6. 验证部署成功

| 检查 | 期望 |
|---|---|
| DSH 日志（`<profile>/logs`，搜 `[wecom-notify]`） | `已加载 · 通道=... · 格式=text`，以及 `控制接口 http://127.0.0.1:8791/ctl/state` |
| 浏览器 console 执行 `fetch('/api/dsh-to-wecom',{method:'POST',headers:{'content-type':'application/json'},body:'{"op":"state"}'}).then(r=>r.json()).then(console.log)` | 返回 `{ok:true,...}` |
| 设置页「发送测试」 | 收到测试消息；失败会显示具体 `errcode` |
| 跑一轮对话 | 该会话已开启时，手机收到 `【完成】会话标题` |

## 7. 升级

```bash
cd dsh-to-wecom
git pull
```

因为是链接安装，代码即刻更新；纯 host 侧改动重启 DSH 生效，**改到 `client.js`（界面）也要重启**。

## 8. 卸载

1. `<profile>/package.json`：删掉 `dependencies` 与 `dsh.profile.bundles` 里的 `dsh-wecom-notify`（或还原 `.bak-dsh-to-wecom`）
2. 删链接：`rm <profile>/node_modules/dsh-wecom-notify`（Windows 用 `Remove-Item`）
3. 重启 DSH

## 9. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 插件没加载 | 日志里没有 `[wecom-notify]`：bundles 没加、profile 名不对、或没重启 |
| 设置页找不到「通知推送」 | 重启过吗？浏览器 console 搜 `dsh-wecom-notify` 看有没有加载错误 |
| 右上角没有开关 | 同上；确认 `package.json` 里有 `dsh.client` 段与 `./client` 导出 |
| `发送测试` 报 93000 | 企业微信 key 无效或机器人被移除 |
| 报 45009 | 企业微信限流（20 条/分钟），插件会自动退避重试 |
| 界面按钮显示「通知离线」 | Host 侧控制路由没注册：日志里应有 `控制接口已挂到 /api/dsh-to-wecom`；没有则说明 `connection` 服务不可用或插件没加载 |
| 企业微信应用消息报 60020 | 服务器出口 IP 不在「企业可信 IP」白名单里 |

## 10. 安全

- 仓库不含任何凭据；`npm run check:secrets` 可自检（详见 [SECURITY.md](../SECURITY.md)）
- 控制接口只绑 `127.0.0.1`，别转发到公网；不需要时 `controlEnabled: false` 关掉
- 通知正文可能包含你机器上的路径 / 命令 / 代码片段，注意接收方