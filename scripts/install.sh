#!/bin/sh
# dsh-to-wecom 安装脚本（macOS / Linux）
#  1) 在 <profile>/node_modules 下建符号链接指向本仓库
#  2) 在 <profile>/package.json 里补 dependencies 与 dsh.profile.bundles（写前备份）
# 用法： sh scripts/install.sh [profile名]
set -eu
PROFILE="${1:-desktop}"
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
LINK="$PROFILE_DIR/node_modules/dsh-wecom-notify"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "找不到 profile 目录: $PROFILE_DIR（先启动一次 DSH 让它生成）" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR/node_modules"
rm -f "$LINK"
ln -s "$REPO_DIR" "$LINK"
echo "已建立符号链接: $LINK -> $REPO_DIR"

node -e '
  const fs = require("node:fs");
  const [pkgPath, repoDir] = process.argv.slice(1);
  const json = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  json.dependencies = json.dependencies || {};
  json.dependencies["dsh-wecom-notify"] = "link:" + repoDir;
  const bundles = (((json.dsh || {}).profile || {}).bundles) || null;
  if (!Array.isArray(bundles)) { console.error("这个 package.json 不像 DSH profile"); process.exit(1); }
  if (!bundles.includes("dsh-wecom-notify")) bundles.push("dsh-wecom-notify");
  fs.copyFileSync(pkgPath, pkgPath + ".bak-dsh-to-wecom");
  fs.writeFileSync(pkgPath, JSON.stringify(json, null, 2) + "\n", "utf8");
  console.log("已更新 package.json（备份: " + pkgPath + ".bak-dsh-to-wecom）");
' "$PROFILE_DIR/package.json" "$REPO_DIR"

echo ''
echo '下一步：完全退出 DSH 再启动 -> 设置 -> 插件 -> 通知推送 -> 选服务/填凭据 -> 发送测试'
echo '然后到要收通知的会话，点标题右上角的 推送关 变绿。'
