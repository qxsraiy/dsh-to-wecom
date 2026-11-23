import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { apply } from '../index.js'

const QUEUE_DIR = fileURLToPath(new URL('./.queue-dup', import.meta.url))
rmSync(QUEUE_DIR, { recursive: true, force: true })

const creates = []
let sends = []
const tg = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const method = new URL(req.url, 'http://x').pathname.split('/').pop()
    const j = JSON.parse(body || '{}')
    if (method === 'createForumTopic') creates.push(j)
    if (method === 'sendMessage') sends.push(j)
    if (method === 'getUpdates') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: [] })); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: { message_thread_id: 555, message_id: 1 } }))
  })
})
await new Promise((r) => tg.listen(18097, '127.0.0.1', r))

const handlers = []
const routes = new Map()
const ctx = {
  on(name, fn) { handlers.push([name, fn]); return () => {} },
  effect(fn) { fn() },
  logger: { info() {}, warn() {} },
  get() { return undefined },
  inject(names, cb) { cb({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } }, agents: { get: () => undefined } }) },
}
apply(ctx, {
  provider: 'telegram', telegramApiBase: 'http://127.0.0.1:18097', telegramToken: 'T:T', telegramChatId: '-1001',
  telegramTopics: true, telegramInbound: false, notifyOn: 'every-turn', minGapMs: 5, queueDir: QUEUE_DIR,
})
const route = routes.get('/api/dsh-to-wecom')
const call = async (payload) => (await route.fetch(new Request('http://localhost/api/dsh-to-wecom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))).json()
const session = { id: 'session-8f3a0000', header: { cwd: 'D:/cms' } }
const emit = (type, data) => { for (const [name, fn] of handlers) if (name === 'session/event') fn(session, { type, data, seq: 0, time: Date.now() }) }
const turn = (n) => {
  emit('turn/start', { turn: n })
  emit('assistant/message', { turn: n, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第' + n + '轮' }] } })
  emit('turn/end', { turn: n, reason: { kind: 'completed' } })
}
await call({ op: 'default', enabled: true })
emit('session/title', { title: 'CMS 扫描' })
turn(1)
await new Promise((r) => setTimeout(r, 500))
turn(2)
await new Promise((r) => setTimeout(r, 800))

console.log('createForumTopic 次数 =', creates.length)
console.log('sendMessage threads =', sends.map((s) => s.message_thread_id).join(','))
tg.close()
const ok = creates.length === 1 && sends.length === 2 && sends.every((s) => s.message_thread_id === 555)
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
