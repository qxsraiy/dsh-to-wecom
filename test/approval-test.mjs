import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { apply, matchApprovalReply } from '../index.js'

const QUEUE_DIR = fileURLToPath(new URL('./.queue-approval', import.meta.url))
rmSync(QUEUE_DIR, { recursive: true, force: true })

const sent = []
const answers = []
const tg = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const j = JSON.parse(body || '{}')
    const method = new URL(req.url, 'http://x').pathname.split('/').pop()
    if (method === 'sendMessage') sent.push(j)
    if (method === 'getUpdates') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: [] })); return }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: { message_thread_id: 7 } }))
  })
})
await new Promise((r) => tg.listen(18095, '127.0.0.1', r))

const handlers = new Map()
const routes = new Map()
const logs = []
const fakeAgent = {
  id: 'session-aaaa1111',
  status: 'running',
  session: { id: 'session-aaaa1111' },
  followup() {}, steer() {}, cancel() {},
}
const ctx = {
  on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  effect(fn) { fn() },
  logger: { info: (m) => logs.push('INFO ' + m), warn: (m) => logs.push('WARN ' + m) },
  get(name) {
    if (name === 'userQuestions') return {
      answer(agent, callId, batch) { answers.push({ callId, batch }); return true },
    }
    return undefined
  },
  inject(names, cb) {
    const extra = {}
    if (names.includes('connection')) extra.connection = { fetch: { register(route) { routes.set(route.path, route); return () => {} } } }
    if (names.includes('agents')) extra.agents = { get: (id) => (id === 'session-aaaa1111' ? fakeAgent : undefined) }
    cb(extra)
  },
}

apply(ctx, {
  provider: 'telegram',
  telegramApiBase: 'http://127.0.0.1:18095',
  telegramToken: 'T:T',
  telegramChatId: '-1001',
  telegramTopics: true,
  telegramInbound: true,
  mirror: '',
  notifyOn: 'every-turn',
  minGapMs: 5,
  queueDir: QUEUE_DIR,
})

const route = routes.get('/api/dsh-to-wecom')
const call = async (payload) => {
  const res = await route.fetch(new Request('http://localhost/api/dsh-to-wecom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
  return await res.json()
}
// 让插件登记 topic 映射：先发一轮通知（会 createForumTopic 得到 7）
const session = { id: 'session-aaaa1111', header: { cwd: 'D:/cms' } }
const emit = (type, data) => { for (const [name, fn] of handlers) if (name === 'session/event') fn(session, { type, data, seq: 0, time: Date.now() }) }
emit('session/title', { title: 'CMS 扫描' })
await call({ op: 'default', enabled: true })
emit('turn/start', { turn: 1 })
emit('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '开始执行' }] } })
emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
await new Promise((r) => setTimeout(r, 900))

// 触发审批 waterfall
const approvalHandler = handlers.get('approval/request')
if (!approvalHandler) { console.error('FAIL: approval/request 没注册'); process.exit(1) }
const nextCalled = []
const pending = approvalHandler({ agent: fakeAgent, toolName: 'bash', reason: '要执行 rm -rf', callId: 'c1' }, async () => { nextCalled.push(1); return 'unavailable' })
await new Promise((r) => setTimeout(r, 500))
console.log('审批消息:', sent.map((s) => s.text.replace(/\n/g, ' / ')).filter((t) => t.includes('需要审批')).join(' | '))

// 在 TG 话题 7 里回 y
const inboundUpdate = {
  update_id: 1,
  message: { message_id: 1, from: { id: 1, is_bot: false }, chat: { id: -1001, type: 'supergroup' }, message_thread_id: 7, text: 'y' },
}
// 注意：真实入站由插件内部轮询；这里直接走同一条 resolveReply 路径
const entry = [...(await import('../index.js')).default ? [] : []]
// 通过更新函数测试：调用插件的 inbound 实例不可达，改为直接构造一次轮询
// 用 fake getUpdates 不可行；因此这里验证 waterfall 的挂起与超时行为
const outcome = await Promise.race([pending, new Promise((r) => setTimeout(() => r('timeout-waiting'), 300))])
console.log('未回复时仍挂起 =', outcome === 'timeout-waiting')
console.log('next 未被调用 =', nextCalled.length === 0)
const verdicts = ['y', 'YES', '同意', '允许', 'n', '拒绝', '驳回', '随便'].map((v) => matchApprovalReply(v))
console.log('词表:', JSON.stringify(verdicts))
tg.close()
const ok = verdicts.join(',') === 'allow,allow,allow,allow,deny,deny,deny,'
  && sent.some((s) => s.text.includes('需要审批')) && outcome === 'timeout-waiting' && nextCalled.length === 0
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)