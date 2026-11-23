import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { apply } from '../index.js'

const QUEUE_DIR = fileURLToPath(new URL('./.queue-tools', import.meta.url))
rmSync(QUEUE_DIR, { recursive: true, force: true })

const sent = []
const tg = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const j = JSON.parse(body || '{}')
    const method = new URL(req.url, 'http://x').pathname.split('/').pop()
    if (method === 'sendMessage') sent.push(j)
    if (method === 'getUpdates') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: [] })); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: { message_thread_id: 9 } }))
  })
})
await new Promise((r) => tg.listen(18096, '127.0.0.1', r))

const handlers = []
const routes = new Map()
const logs = []
const ctx = {
  on(name, fn) { handlers.push([name, fn]); return () => {} },
  effect(fn) { fn() },
  logger: { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m) },
  get() { return undefined },
  inject(names, cb) {
    const extra = { connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } }, agents: { get: () => undefined } }
    cb(extra)
  },
}

apply(ctx, {
  provider: 'telegram',
  telegramApiBase: 'http://127.0.0.1:18096',
  telegramToken: 'T:T',
  telegramChatId: '-1001',
  telegramTopics: true,
  telegramInbound: false,
  toolReport: 'turn',
  notifyOn: 'every-turn',
  minGapMs: 5,
  queueDir: QUEUE_DIR,
})

const route = routes.get('/api/dsh-to-wecom')
const call = async (payload) => (await route.fetch(new Request('http://localhost/api/dsh-to-wecom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))).json()
const session = { id: 'session-aaaa1111', header: { cwd: 'D:/cms' } }
const emit = (type, data) => { for (const [name, fn] of handlers) if (name === 'session/event') fn(session, { type, data, seq: 0, time: Date.now() }) }

await call({ op: 'default', enabled: true })
emit('session/title', { title: 'CMS 扫描' })
emit('turn/start', { turn: 2 })
emit('tool/call', { callId: 'c1', name: 'bash', args: { command: 'ls' } })
emit('tool/result', { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'report.md\nscan.txt' }] } })
emit('tool/call', { callId: 'c2', name: 'read', args: { path: 'x' } })
emit('tool/result', { message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'not found' }], isError: true } })
emit('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '跑完了' }] } })
emit('turn/end', { turn: 2, reason: { kind: 'completed' } })

await new Promise((r) => setTimeout(r, 900))
const body = sent.map((s) => s.text).join('\n---\n')
console.log(body)
tg.close()
const ok = body.includes('工具：') && body.includes('bash ✓') && /read ✗/.test(body) && body.includes('report.md')
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)