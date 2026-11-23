#!/usr/bin/env node
/**
 * 会话日志修复：DSH 的 session.v4.jsonl.zstd 是「多帧拼接」的，
 * 某个事件写坏（例如缺 source）会让整段历史加载失败。
 * 这个脚本按 zstd 帧切分、逐帧解码校验，找到第一个非法事件，
 * 把文件截断到它之前那一帧的边界（= 丢掉最后几个坏事件，保留完整前缀）。
 *
 * 用法：
 *   node scripts/repair-session.mjs <session.v4.jsonl.zstd>           # 只检查，不改
 *   node scripts/repair-session.mjs <path> --apply                   # 备份后截断
 */
import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const apply = process.argv.includes('--apply')
if (!file) { console.error('用法: node scripts/repair-session.mjs <session.v4.jsonl.zstd> [--apply]'); process.exit(2) }

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = readFileSync(file)
const offsets = []
for (let i = 0; i <= buf.length - 4; i += 1) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
}

const MESSAGE_TYPES = new Set(['user/message', 'developer/message', 'system/message', 'assistant/message', 'tool/result'])
let lastGoodEnd = 0
let badFrame = -1
let badReason = ''
let events = 0

for (let k = 0; k < offsets.length; k += 1) {
  const start = offsets[k]
  const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
  let text
  try { text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8') } catch (error) { badFrame = k; badReason = 'zstd 帧解码失败: ' + error.message; break }
  let ok = true
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch (error) { ok = false; badReason = 'JSON 解析失败: ' + error.message; break }
    events += 1
    if (!MESSAGE_TYPES.has(ev.type)) continue
    const message = ev.type === 'user/message' ? ev.data : (ev.data && ev.data.message)
    if (!message || !message.source || typeof message.source.kind !== 'string' || message.source.kind === '') {
      ok = false
      badReason = 'seq ' + String(ev.seq) + ' / ' + ev.type + ' 缺 source.kind'
      break
    }
  }
  if (!ok) { badFrame = k; break }
  lastGoodEnd = end
}

console.log('文件: ' + file + ' (' + statSync(file).size + ' 字节)')
console.log('帧数: ' + offsets.length + ' · 有效事件: ' + events)
if (badFrame < 0) { console.log('未发现损坏，无需修复'); process.exit(0) }
console.log('第一个坏帧: #' + badFrame + ' · 原因: ' + badReason)
console.log('可安全截断到: ' + lastGoodEnd + ' 字节（保留 ' + lastGoodEnd + ' / ' + buf.length + '）')
if (!apply) { console.log('这是检查模式；加 --apply 才会真的截断（会先备份 .bak）'); process.exit(0) }
const backup = file + '.bak-' + Date.now()
copyFileSync(file, backup)
writeFileSync(file, buf.subarray(0, lastGoodEnd))
console.log('已截断，备份: ' + backup)
