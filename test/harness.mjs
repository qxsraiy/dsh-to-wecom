import http from 'node:http'
import { apply } from '../index.js'

const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    received.push(JSON.parse(body))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
  })
})
await new Promise((r) => server.listen(18083, '127.0.0.1', r))

const handlers = []
const logs = []
const ctx = {
  on(name, fn) { handlers.push([name, fn]); return () => {} },
  effect(fn) { fn() },
  logger: { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m) },
}

apply(ctx, {
  webhookUrl: 'http://127.0.0.1:18083/send?key=test',
  format: 'text',
  notifyOn: 'every-turn',
  minGapMs: 10,
  queueDir: new URL('./.queue', import.meta.url).pathname,
})

const session = { id: 'session-abcd1234', header: { cwd: 'D:\\aiwork\\cms' } }
const emit = (type, data) => { for (const [name, fn] of handlers) if (name === 'session/event') fn(session, { type, data, seq: 0, time: Date.now() }) }

const paragraphs = Array.from({ length: 45 }, (_, i) => '第 ' + (i + 1) + ' 段：目标 10.0.0.' + (i + 1) + ' 开放 443，证书 CN=internal.example，建议标注风险等级与复测时间。')

emit('session/title', { title: '渗透报告整理' })
emit('turn/start', { turn: 9 })
emit('assistant/message', { turn: 9, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: paragraphs.slice(0, 20).join('\n\n') }] } })
emit('assistant/message', { turn: 9, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: paragraphs.slice(20).join('\n\n') }] } })
emit('turn/end', { turn: 9, reason: { kind: 'completed' } })

await new Promise((r) => setTimeout(r, 3000))
console.log(logs.join('\n'))
let i = 0
for (const p of received) {
  i += 1
  const c = p.text ? p.text.content : p.markdown.content
  console.log('--- part ' + i + '/' + received.length + ' · bytes=' + Buffer.byteLength(c, 'utf8') + ' ---')
  console.log(c.slice(0, 160))
  console.log('...')
}
server.close()
const sizes = received.map((p) => Buffer.byteLength((p.text || p.markdown).content, 'utf8'))
const joined = received.map((p) => (p.text || p.markdown).content).join('\n')
const complete = paragraphs.every((t) => joined.includes(t))
const ok = received.length > 1 && sizes.every((n) => n <= 2048) && complete
console.log('parts=' + received.length + ' sizes=' + sizes.join(',') + ' complete=' + complete + ' -> ' + (ok ? 'PASS' : 'FAIL'))
if (!ok) process.exit(1)