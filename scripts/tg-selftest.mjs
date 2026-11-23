
import { readFileSync } from 'node:fs'
import { sendNotification } from '../notify.js'

const s = JSON.parse(readFileSync('D:/aiwork/dsh通知/data/queue/settings.json', 'utf8'))
const cfg = {
  provider: 'telegram',
  telegramToken: s.telegramToken,
  telegramChatId: s.telegramChatId,
  telegramTopics: true,
  proxyUrl: s.proxyUrl,
  format: 'text',
}
console.log('chat =', cfg.telegramChatId, '| proxy =', cfg.proxyUrl, '| token set =', Boolean(cfg.telegramToken))
try {
  const r = await sendNotification(cfg, '[DSH] 连接测试\n如果你看到这条，说明 TG 通道已通。', { title: '连接测试', sessionId: 'session-test0001' })
  console.log('SENT', JSON.stringify(r))
} catch (e) {
  console.error('FAIL', e.message)
  process.exit(1)
}