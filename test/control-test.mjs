import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { apply } from '../index.js'

const QUEUE_DIR = fileURLToPath(new URL('./.queue-control', import.meta.url))
rmSync(QUEUE_DIR, { recursive: true, force: true })

const received = []
const hook = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    received.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
  })
})
await new Promise((r) => hook.listen(18091, '127.0.0.1', r))

const handlers = []
const routes = new Map()
const logs = []
const ctx = {
  on(name, fn) { handlers.push([name, fn]); return () => {} },
  effect(fn) { fn() },
  logger: { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m) },
  inject(names, callback) {
    callback({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } } })
  },
}

apply(ctx, {
  provider: 'wecom-robot',
  wecomApiBase: 'http://127.0.0.1:18091',
  wecomKey: 'test',
  format: 'text',
  notifyOn: 'every-turn',
  minGapMs: 5,
  queueDir: QUEUE_DIR,
})

const route = routes.get('/api/dsh-to-wecom')
if (!route) { console.error('FAIL: 控制路由没有注册'); process.exit(1) }

const call = async (payload) => {
  const res = await route.fetch(new Request('http://localhost/api/dsh-to-wecom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return await res.json()
}

const a = { id: 'session-aaaa1111', header: { cwd: 'D:\\aiwork\\cms' } }
const b = { id: 'session-bbbb2222', header: { cwd: 'D:\\aiwork\\cms' } }
const emit = (session, type, data) => { for (const [name, fn] of handlers) if (name === 'session/event') fn(session, { type, data, seq: 0, time: Date.now() }) }
const turn = (session, n) => {
  emit(session, 'turn/start', { turn: n })
  emit(session, 'assistant/message', { turn: n, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '会话输出 ' + n }] } })
  emit(session, 'turn/end', { turn: n, reason: { kind: 'completed' } })
}

emit(a, 'session/title', { title: 'CMS 扫描' })
emit(b, 'session/title', { title: 'CMS 报告' })
await new Promise((r) => setTimeout(r, 100))

const initial = await call({ op: 'state', sessionId: 'session-aaaa1111' })
console.log('默认 =', initial.default, '| A =', JSON.stringify(initial.session))

turn(a, 1)
turn(b, 1)
await new Promise((r) => setTimeout(r, 500))
const offCount = received.length
console.log('默认关闭时收到 =', offCount)

const on = await call({ op: 'toggle', sessionId: 'session-aaaa1111' })
console.log('A 打开后 =', JSON.stringify(on.session))

turn(a, 2)
turn(b, 2)
await new Promise((r) => setTimeout(r, 700))

const cfg = await call({ op: 'config' })
console.log('config providers =', (cfg.providers || []).join(','), '| provider =', cfg.provider)

console.log(logs.join('\n'))
console.log('最终收到 =', received.length)
for (const m of received) console.log('  · ' + (m.text || m.markdown).content.split('\n')[0])
hook.close()
const ok = offCount === 0 && received.length === 1 && initial.default === false && on.session.enabled === true && Array.isArray(cfg.providers)
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
