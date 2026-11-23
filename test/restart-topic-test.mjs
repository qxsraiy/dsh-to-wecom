import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { rmSync, readFileSync } from 'node:fs'
import { apply } from '../index.js'

const QUEUE_DIR = fileURLToPath(new URL('./.queue-restart', import.meta.url))
rmSync(QUEUE_DIR, { recursive: true, force: true })

let creates = 0
let threads = []
const tg = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const method = new URL(req.url, 'http://x').pathname.split('/').pop()
    const j = JSON.parse(body || '{}')
    if (method === 'createForumTopic') { creates += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { message_thread_id: 777 } })); return }
    if (method === 'sendMessage') threads.push(j.message_thread_id)
    if (method === 'getUpdates') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: [] })); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }))
  })
})
await new Promise((r) => tg.listen(18098, '127.0.0.1', r))

function boot(label) {
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
    provider: 'telegram', telegramApiBase: 'http://127.0.0.1:18098', telegramToken: 'T:T', telegramChatId: '-1001',
    telegramTopics: true, telegramInbound: false, notifyOn: 'every-turn', minGapMs: 5, queueDir: QUEUE_DIR,
  })
  const route = routes.get('/api/dsh-to-wecom')
  const call = async (payload) => (await route.fetch(new Request('http://localhost/api/dsh-to-wecom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))).json()
  const session = { id: 'session-restart01', header: { cwd: 'D:/cms' } }
  const emit = (type, data) => { for (const [name, fn] of handlers) if (name === 'session/event') fn(session, { type, data, seq: 0, time: Date.now() }) }
  return { call, emit, label }
}

// 第一次启动：建话题
const a = boot('first')
await a.call({ op: 'default', enabled: true })
a.emit('session/title', { title: '重启测试' })
a.emit('turn/start', { turn: 1 })
a.emit('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一轮' }] } })
a.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
await new Promise((r) => setTimeout(r, 700))
const persisted = JSON.parse(readFileSync(QUEUE_DIR + '/sessions.json', 'utf8'))
console.log('第一次 createForumTopic =', creates, '| topics 文件 =', JSON.stringify(persisted.topics))

// 模拟重启：重新 apply，同一数据目录
await new Promise((r) => setTimeout(r, 200))
const b = boot('second')
await new Promise((r) => setTimeout(r, 300))
b.emit('session/title', { title: '重启测试' })
b.emit('turn/start', { turn: 2 })
b.emit('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第二轮' }] } })
b.emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
await new Promise((r) => setTimeout(r, 700))

console.log('两次启动后 createForumTopic 总数 =', creates, '| 发送 thread =', threads.join(','))
tg.close()
const ok = creates === 1 && threads.length === 2 && threads.every((t) => t === 777)
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
