import { createTelegramInbound } from '../inbound.js'

const events = []
const sent = []
const prefs = { topics: { 'session-aaaa1111': 11 }, sessions: {}, bindings: {} }
const sessions = new Map([['session-aaaa1111', { title: 'CMS 扫描', cwd: 'D:/cms' }]])

const inbound = createTelegramInbound({
  cfg: { telegramUserId: '1', telegramChatId: '-1001' },
  log: { info() {}, warn() {} },
  agents: { get: () => undefined },
  sessions,
  prefs,
  savePrefs() {},
  store: { get: () => undefined, set() {} },
  api: { getUpdates: async () => [] },
  sendMessage: async (threadId, text) => { sent.push({ threadId, text }) },
  onTopicClosed: async (sessionId) => { events.push(['closed', sessionId]) },
  onTopicReopened: async (sessionId) => { events.push(['reopened', sessionId]) },
  onTopicCreated: async (sessionId, chatId, threadId) => { events.push(['created', chatId, threadId]) },
})

const base = (extra) => ({ update_id: 1, message: { message_id: 1, from: { id: 1, is_bot: false }, chat: { id: -1001, type: 'supergroup' }, message_thread_id: 11, ...extra } })

await inbound.handleUpdate(base({ forum_topic_closed: {} }))
await inbound.handleUpdate(base({ forum_topic_reopened: {} }))
await inbound.handleUpdate(base({ message_thread_id: 55, forum_topic_created: { name: '手工新话题' } }))

console.log('EVENTS:', JSON.stringify(events))
const ok = events.length === 3
  && events[0][0] === 'closed' && events[0][1] === 'session-aaaa1111'
  && events[1][0] === 'reopened' && events[1][1] === 'session-aaaa1111'
  && events[2][0] === 'created' && events[2][2] === 55
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
