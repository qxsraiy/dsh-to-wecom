
import { readFileSync } from 'node:fs'
import { telegramCall } from '../notify.js'

const s = JSON.parse(readFileSync('D:/aiwork/dsh通知/data/queue/settings.json', 'utf8'))
for (const proxyUrl of ['socks5://192.168.2.1:1070', 'http://127.0.0.1:7890']) {
  try {
    const r = await telegramCall({ telegramToken: s.telegramToken, proxyUrl }, 'getMe', {})
    console.log(proxyUrl, '->', r.status, JSON.stringify(r.json).slice(0, 160))
  } catch (e) {
    console.log(proxyUrl, '-> FAIL', e.message)
  }
}
