#!/usr/bin/env node
/**
 * 提交前哨：扫描仓库里是否出现真实推送凭据。
 * 只做模式匹配，纯本地运行，零依赖。发现命中就以退出码 1 结束。
 *
 * 用法：node scripts/check-secrets.mjs [目录]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.argv[2] || process.cwd()
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', '.queue-harness', '.queue-control'])
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.tgz', '.exe', '.apk', '.woff', '.woff2'])

// 企业微信群机器人 key：uuid 形状；Telegram bot token：<数字>:<35+ 字符>；钉钉 access_token：长 hex
const PATTERNS = [
  { name: 'wecom-robot key', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g },
  { name: 'telegram bot token', re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  { name: 'dingtalk access_token', re: /access_token=[0-9a-f]{32,}/g },
  { name: 'webhook url with key', re: /webhook\/send\?key=[0-9a-zA-Z-]{16,}/g },
  { name: 'bearer literal', re: /Authorization[\"']?\s*[:=]\s*[\"']Bearer\s+[A-Za-z0-9._-]{20,}/g },
]

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) { walk(full, out); continue }
    const dot = entry.lastIndexOf('.')
    if (dot >= 0 && SKIP_EXT.has(entry.slice(dot).toLowerCase())) continue
    if (stat.size > 2 * 1024 * 1024) continue
    out.push(full)
  }
  return out
}

const hits = []
for (const file of walk(root, [])) {
  let text
  try { text = readFileSync(file, 'utf8') } catch (error) { continue }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0
      const match = re.exec(lines[i])
      if (!match) continue
      const value = match[0]
      // 允许明显的占位符
      if (/^0{8}|xxxx|your|你的|示例|placeholder/i.test(value)) continue
      hits.push({ file: relative(root, file), line: i + 1, rule: name, sample: value.slice(0, 12) + '…' })
    }
  }
}

if (hits.length === 0) {
  console.log('check-secrets: 未发现真实推送凭据 ✓')
  process.exit(0)
}

console.error('check-secrets: 发现疑似真实凭据，请改用占位符或加密钥到 settings.json：')
for (const hit of hits) console.error('  - ' + hit.file + ':' + hit.line + ' [' + hit.rule + '] ' + hit.sample)
process.exit(1)
