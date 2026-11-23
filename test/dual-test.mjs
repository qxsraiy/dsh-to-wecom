import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { apply } from '../index.js'

const QUEUE_DIR = fileURLToPath(new URL('./.queue-dual', import.meta.url))
rmSync(QUEUE_DIR, { recursive: true, force: true })

const tgCalls = []
const wcCalls = []

const tg = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    const method = url.pathname.split('/').pop()
    tgCalls.push({ method, body: JSON.parse(body || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (method === 'createForumTopic') res.end(JSON.stringify({ ok: true, result: { message_thread_id: 4242, name: 'topic' } }))
    else res.end(JSON.stringify({ ok: true, result: { message_id: 99 } }))
  })
})
const wc = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => { wcCalls.push(JSON.parse(body || '{}')); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' })) })
})
await new Promise((r) => tg.listen(18093, '127.0.0.1', r))
await new Promise((r) => wc.listen(18094, '127.0.0.1', r))

const handlers = []
const routes = new Map()
const logs = []
const ctx = {
  on(name, fn) { handlers.push([name, fn]); return () => {} },
  effect(fn) { fn() },
  logger: { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m) },
  inject(names, callback) { callback({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } } }) },
}

apply(ctx, {
  provider: 'telegram',
  telegramApiBase: 'http://127.0.0.1:18093',
  telegramToken: 'TEST:TOKEN',
  telegramChatId: '-100123',
  telegramTopics: true,
  mirror: 'wecom-robot',
  wecomApiBase: 'http://127.0.0.1:18094',
  wecomKey: 'mirror-key',
  format: 'text',
  notifyOn: 'every-turn',
  minGapMs: 5,
  queueDir: QUEUE_DIR,
})

const route = routes.get('/api/dsh-to-wecom')
const call = async (payload) => {
  const res = await route.fetch(new Request('http://localhost/api/dsh-to-wecom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
  return await res.json()
}

const session = { id: 'session-8f3a0000', header: { cwd: 'D:\\aiwork\\cms' } }
const emit = (type, data) => { for (const [name, fn] of handlers) if (name === 'session/event') fn(session, { type, data, seq: 0, time: Date.now() }) }
emit('session/title', { title: 'CMS 扫描' })
await call({ op: 'default', enabled: true })
emit('turn/start', { turn: 1 })
emit('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '报告已生成。' }] } })
emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

await new Promise((r) => setTimeout(r, 1200))
console.log('TG 调用:')
for (const c of tgCalls) console.log('  · ' + c.method + ' ' + JSON.stringify(c.body).slice(0, 160))
console.log('企微镜像:')
for (const c of wcCalls) console.log('  · ' + JSON.stringify(c).slice(0, 200))
console.log(logs.join('\n'))
tg.close(); wc.close()

const created = tgCalls.some((c) => c.method === 'createForumTopic')
const sent = tgCalls.find((c) => c.method === 'sendMessage')
const ok = created && sent && sent.body.message_thread_id === 4242 && sent.body.text.includes('报告已生成') && wcCalls.length === 1 && wcCalls[0].text.content.startsWith('[#')
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
