
import { readFileSync } from 'node:fs'
import { telegramCall } from '../notify.js'

const s = JSON.parse(readFileSync('D:/aiwork/dsh通知/data/queue/settings.json', 'utf8'))
console.log('settings: provider=', s.provider, '| inbound=', s.telegramInbound, '| proxy=', s.proxyUrl, '| chat=', s.telegramChatId, '| user=', s.telegramUserId)
const cfg = { telegramToken: s.telegramToken, proxyUrl: s.proxyUrl }
const info = await telegramCall(cfg, 'getWebhookInfo', {})
console.log('webhook:', JSON.stringify(info.json).slice(0, 300))
const updates = await telegramCall(cfg, 'getUpdates', { offset: 0, timeout: 0, limit: 5 })
console.log('updates ok=', updates.json.ok, 'count=', Array.isArray(updates.json.result) ? updates.json.result.length : 'n/a')
for (const u of (updates.json.result || []).slice(-3)) {
  const m = u.message || {}
  console.log('  · from=' + (m.from && m.from.id), 'chat=' + (m.chat && m.chat.id), 'type=' + (m.chat && m.chat.type), 'thread=' + m.message_thread_id, 'text=' + String(m.text || '').slice(0, 30))
}
