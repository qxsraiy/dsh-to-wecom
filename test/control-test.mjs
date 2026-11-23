import http from 'node:http'
import { apply } from '../index.js'

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
const logs = []
const ctx = {
  on(name, fn) { handlers.push([name, fn]); return () => {} },
  effect(fn) { fn() },
  logger: { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m) },
}

apply(ctx, {
  webhookUrl: 'http://127.0.0.1:18091/send?key=test',
  format: 'text',
  notifyOn: 'every-turn',
  minGapMs: 5,
  queueDir: new URL('./.queue', import.meta.url).pathname,
  controlPort: 18792,
})

// 两个会话、同一个目录，验证按会话区分
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
const base = 'http://127.0.0.1:18792'
await new Promise((r) => setTimeout(r, 400))

const s1 = await (await fetch(base + '/ctl/state?session=session-aaaa1111')).json()
console.log('session A state =', JSON.stringify(s1.session))

const off = await (await fetch(base + '/ctl/toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-aaaa1111' }) })).json()
console.log('A toggled       =', JSON.stringify(off.session))

turn(a, 1)   // A 已静音 -> 不发
turn(b, 1)   // B 默认开 -> 发
await new Promise((r) => setTimeout(r, 600))

turn(a, 2)   // A 仍然静音
turn(b, 2)   // B 再发一条
await new Promise((r) => setTimeout(r, 600))

console.log('logs:\n' + logs.join('\n'))
console.log('received =', received.length)
for (const m of received) console.log('  · ' + (m.text || m.markdown).content.split('\n')[0])
hook.close()
const ok = received.length === 2 && s1.session.enabled === true && off.session.enabled === false
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)