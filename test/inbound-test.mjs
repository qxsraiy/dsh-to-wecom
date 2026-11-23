import { createTelegramInbound } from '../inbound.js'

const sent = []
const renames = []
const calls = []
const prefs = { defaultEnabled: false, sessions: {}, topics: { 'session-aaaa1111': 11, 'session-bbbb2222': 22 }, bindings: {} }
const sessionInfo = new Map([
  ['session-aaaa1111', { title: 'CMS 扫描', cwd: 'D:/cms' }],
  ['session-bbbb2222', { title: '报告整理', cwd: 'D:/rep' }],
])
const agentCalls = []
const fakeAgent = (id) => ({ status: 'idle', followup: (input) => agentCalls.push({ id, kind: 'followup', text: input.content[0].text }), steer: (input) => agentCalls.push({ id, kind: 'steer', text: input.content[0].text }), cancel: () => agentCalls.push({ id, kind: 'cancel' }) })
const agents = { get: (id) => (sessionInfo.has(id) ? fakeAgent(id) : undefined) }

const inbound = createTelegramInbound({
  cfg: { telegramUserId: '1107421079', telegramChatId: '-1001' },
  log: { info() {}, warn: (m) => calls.push('WARN ' + m) },
  agents,
  sessions: sessionInfo,
  prefs,
  savePrefs() {},
  store: { get: () => undefined, set() {} },
  api: { getUpdates: async () => [] },
  sendMessage: async (threadId, text) => { sent.push({ threadId, text }) },
  renameSession: async (sessionId, title) => { renames.push({ sessionId, title }) },
})

const upd = (threadId, text, fromId = '1107421079') => ({
  update_id: 1,
  message: {
    message_id: 1,
    from: { id: Number(fromId), is_bot: false },
    chat: { id: -1001, type: 'supergroup' },
    message_thread_id: threadId,
    text,
  },
})

// 1) 话题路由：11 -> session A
await inbound.handleUpdate(upd(11, '继续跑'))
// 2) 话题路由：22 -> session B
await inbound.handleUpdate(upd(22, '改一下标题'))
// 3) 前缀 ! -> steer
await inbound.handleUpdate(upd(11, '! 注意别删文件'))
// 4) 命令 /tasks
await inbound.handleUpdate(upd(11, '/tasks'))
// 5) 未绑定话题：33 提示
await inbound.handleUpdate(upd(33, '你好'))
// 6) /rename
await inbound.handleUpdate(upd(11, '/rename 新的任务名'))
// 7) 非白名单用户
await inbound.handleUpdate(upd(11, '陌生人指令', '999'))

console.log('AGENT:', JSON.stringify(agentCalls, null, 0))
console.log('SENT:')
for (const s of sent) console.log('  thread=' + s.threadId + ' | ' + s.text.replace(/\n/g, ' / '))
const ok = renames.length === 1 && renames[0].sessionId === 'session-aaaa1111' && renames[0].title === '新的任务名'
  && sent.some((s) => s.text.includes('已改名：新的任务名'))
  && agentCalls.length === 3
  && agentCalls[0].id === 'session-aaaa1111' && agentCalls[0].kind === 'followup'
  && agentCalls[1].id === 'session-bbbb2222'
  && agentCalls[2].kind === 'steer'
  && sent.some((s) => s.text.includes('1) #aaaa')) 
  && sent.some((s) => s.text.includes('还没绑定'))
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)