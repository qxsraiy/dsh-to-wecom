import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { apply } from '../index.js'

const QUEUE_DIR = fileURLToPath(new URL('./.queue-title', import.meta.url))
rmSync(QUEUE_DIR, { recursive: true, force: true })

const calls = []
const tg = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const method = new URL(req.url, 'http://x').pathname.split('/').pop()
    calls.push({ method, body: JSON.parse(body || '{}') })
    if (method === 'getUpdates') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: [] })); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: { message_thread_id: 321, message_id: 1 } }))
  })
})
await new Promise((r) => tg.listen(18099, '127.0.0.1', r))

const handlers = []
const routes = new Map()
const ctx = {
  on(n, f) { handlers.push([n, f]); return () => {} },
  effect(f) { f() },
  logger: { info() {}, warn() {} },
  get() { return undefined },
  inject(n, cb) { cb({ connection: { fetch: { register(r) { routes.set(r.path, r); return () => {} } } }, agents: { get: () => undefined } }) },
}
apply(ctx, {
  provider: 'telegram', telegramApiBase: 'http://127.0.0.1:18099', telegramToken: 'T:T', telegramChatId: '-1001',
  telegramTopics: true, telegramInbound: false, notifyOn: 'every-turn', minGapMs: 5, queueDir: QUEUE_DIR,
})
const route = routes.get('/api/dsh-to-wecom')
const call = async (p) => (await route.fetch(new Request('http://localhost/api/dsh-to-wecom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }))).json()

// 会话日志里已经有标题（模拟插件加载前就生成过），但没有任何实时 title 事件
let logTitle = '渗透测试报告'
const session = {
  id: 'session-title01',
  header: { cwd: 'D:/cms' },
  snapshotEvents() {
    return [{ type: 'u' }, { type: 'session/title', data: { title: logTitle } }]
  },
}
const emit = (type, data) => { for (const [n, f] of handlers) if (n === 'session/event') f(session, { type, data, seq: 0, time: Date.now() }) }
await call({ op: 'default', enabled: true })
emit('turn/start', { turn: 1 })
emit('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '跑完了' }] } })
emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
await new Promise((r) => setTimeout(r, 700))
const created = calls.find((c) => c.method === 'createForumTopic')
console.log('建话题用的名字 =', created && created.body.name)

// 标题后来变了 -> 应该 editForumTopic
logTitle = '渗透测试报告 v2'
emit('turn/start', { turn: 2 })
emit('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第二轮' }] } })
emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
await new Promise((r) => setTimeout(r, 700))
const edits = calls.filter((c) => c.method === 'editForumTopic')
console.log('改名调用 =', edits.map((e) => e.body.name).join(' | '))
tg.close()
const ok = created && created.body.name === '[#titl] 渗透测试报告' && edits.length === 1 && edits[0].body.name === '[#titl] 渗透测试报告 v2'
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
