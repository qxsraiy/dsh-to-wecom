/**
 * Telegram 入站控制：长轮询 getUpdates（出站，无公网回调）。
 * 路由规则：
 *   1. 消息带 message_thread_id（话题）→ 该话题绑定的 sessionId
 *   2. 私聊 → 该 chat 的当前绑定
 *   3. 都没有 → 只有一个活跃会话就用它，否则提示 /use
 * 投递：普通文字 = agent.followup({role:'user',...})（开新一轮）；前缀 ! = agent.steer（纠偏当前 turn）。
 */

const MAX_TEXT = 4000

function textOf(message) {
  if (!message) return ''
  if (typeof message.text === 'string') return message.text
  if (typeof message.caption === 'string') return message.caption
  return ''
}

export function createTelegramInbound(options) {
  const { cfg, api, log, store, agents, sessions, savePrefs, prefs, sendMessage, renameSession, resolveReply, onTopicClosed, onTopicReopened, onTopicCreated, diag } = options
  let offset = Number(store.get('offset') || 0)
  let running = false
  let timer = null

  const chatKey = (chatId, threadId) => String(chatId) + (threadId ? (':' + threadId) : '')

  function shortId(sessionId) {
    return String(sessionId || '').replace(/^session-/, '').slice(0, 4)
  }

  function sessionOfThread(threadId) {
    const topics = prefs.topics || {}
    for (const [sessionId, id] of Object.entries(topics)) if (Number(id) === Number(threadId)) return sessionId
    return ''
  }

  function listSessions() {
    const rows = [...sessions.entries()].map(([id, s], index) => ({
      index: index + 1,
      id,
      short: shortId(id),
      title: s.title || s.cwd || id,
    }))
    return rows
  }

  function resolveTarget(message) {
    const chatId = message.chat && message.chat.id
    const threadId = message.message_thread_id
    if (threadId) {
      const byThread = sessionOfThread(threadId)
      if (byThread) return { sessionId: byThread, via: 'topic' }
    }
    if (message.chat && message.chat.type !== 'private' && threadId && Number(threadId) === 1) {
      // General 话题：回落到 chat 级绑定
    }
    const bound = (prefs.bindings || {})[chatKey(chatId, threadId)] || (prefs.bindings || {})[String(chatId)]
    if (bound && sessions.has(bound)) return { sessionId: bound, via: 'binding' }
    const list = listSessions()
    if (list.length === 1) return { sessionId: list[0].id, via: 'only-session' }
    return { sessionId: '', via: 'none' }
  }

  function bind(chatId, threadId, sessionId) {
    prefs.bindings = prefs.bindings || {}
    prefs.bindings[chatKey(chatId, threadId)] = sessionId
    if (savePrefs) savePrefs()
  }

  function agentOf(sessionId) {
    try {
      return agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    } catch (error) { return undefined }
  }

  async function handleCommand(message, text, chatId, threadId) {
    const parts = text.trim().split(/\s+/)
    const cmd = parts[0].toLowerCase()
    const arg = parts.slice(1).join(' ')
    if (cmd === '/tasks' || cmd === '/sessions') {
      const list = listSessions()
      const lines = list.length === 0 ? ['（没有活跃会话）'] : list.map((r) => r.index + ') #' + r.short + ' · ' + r.title)
      const current = resolveTarget(message)
      lines.push('', '当前：' + (current.sessionId ? ('#' + shortId(current.sessionId)) : '未绑定') + ' · 用 /use <编号|短号> 切换')
      await sendMessage(threadId, lines.join('\n'))
      return true
    }
    if (cmd === '/use' || cmd === '/bind') {
      const list = listSessions()
      let target = ''
      const byIndex = Number(arg)
      if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= list.length) target = list[byIndex - 1].id
      if (!target && arg) {
        const hit = list.find((r) => r.short === arg.replace(/^#/, '') || r.id === arg)
        if (hit) target = hit.id
      }
      if (!target) {
        await sendMessage(threadId, '没找到这个会话，用 /tasks 看列表')
        return true
      }
      bind(chatId, threadId, target)
      await sendMessage(threadId, '已绑定 #' + shortId(target) + (threadId ? '' : '（本私聊）'))
      return true
    }
    if (cmd === '/status' || cmd === '/whoami') {
      const current = resolveTarget(message)
      const agent = current.sessionId ? agentOf(current.sessionId) : undefined
      await sendMessage(threadId, '会话：' + (current.sessionId ? ('#' + shortId(current.sessionId)) : '未绑定') + '\n状态：' + (agent ? agent.status : '未知') + '\n来源：' + current.via)
      return true
    }
    if (cmd === '/ping') {
      await sendMessage(threadId, 'pong · 会话索引 ' + listSessions().length + ' 个')
      return true
    }
    if (cmd === '/rename') {
      const current = resolveTarget(message)
      if (!current.sessionId) { await sendMessage(threadId, '先 /tasks 选一个会话再改名'); return true }
      const newTitle = arg.trim()
      if (!newTitle) { await sendMessage(threadId, '用法：/rename 新标题'); return true }
      if (typeof renameSession !== 'function') { await sendMessage(threadId, '这个 DSH 没有可用的标题服务'); return true }
      try {
        await renameSession(current.sessionId, newTitle)
        await sendMessage(threadId, '已改名：' + newTitle)
      } catch (error) {
        await sendMessage(threadId, '改名失败：' + String(error && error.message ? error.message : error))
      }
      return true
    }
    if (cmd === '/stop') {
      const current = resolveTarget(message)
      const agent = current.sessionId ? agentOf(current.sessionId) : undefined
      if (!agent) { await sendMessage(threadId, '没有可停止的会话'); return true }
      try { agent.cancel({ kind: 'user-abort' }) } catch (error) { /* ignore */ }
      await sendMessage(threadId, '已请求中断 #' + shortId(current.sessionId))
      return true
    }
    return false
  }

  async function handleUpdate(update) {
    const message = update && (update.message || update.edited_message)
    if (!message) return
    const from = message.from || {}
    if (from.is_bot) return

    // 话题生命周期服务消息（关闭/重开/新建）。注意：Telegram 删除话题不会给 bot 事件。
    const threadOf = message.message_thread_id
    if (message.forum_topic_closed || message.forum_topic_reopened || message.forum_topic_created) {
      const allowedCtrl = String(cfg.telegramUserId || '').trim()
      if (allowedCtrl && String(from.id) !== allowedCtrl) return
      const chatId0 = message.chat && message.chat.id
      const current = resolveTarget(message)
      if (message.forum_topic_closed && typeof onTopicClosed === 'function') {
        await onTopicClosed(current.sessionId || '', chatId0, threadOf)
      } else if (message.forum_topic_reopened && typeof onTopicReopened === 'function') {
        await onTopicReopened(current.sessionId || '', chatId0, threadOf)
      } else if (message.forum_topic_created && typeof onTopicCreated === 'function') {
        await onTopicCreated(current.sessionId || '', chatId0, threadOf, message.forum_topic_created)
      }
      return
    }
    const allowed = String(cfg.telegramUserId || '').trim()
    if (allowed && String(from.id) !== allowed) {
      if (log && log.info) log.info('[wecom-notify] 忽略非白名单 TG 用户 ' + String(from.id))
      return
    }
    const text = textOf(message).slice(0, MAX_TEXT)
    if (!text) return
    const chatId = message.chat && message.chat.id
    const threadId = message.message_thread_id
    if (text.startsWith('/')) {
      try { if (await handleCommand(message, text, chatId, threadId)) return } catch (error) {
        if (log && log.warn) log.warn('[wecom-notify] TG 命令处理失败: ' + String(error))
      }
    }
    const target = resolveTarget(message)
    if (target.sessionId && typeof resolveReply === 'function') {
      try {
        if (await resolveReply(target.sessionId, text)) return
      } catch (error) {
        if (log && log.warn) log.warn('[wecom-notify] 审批/提问回填失败: ' + String(error))
      }
    }
    if (!target.sessionId) {
      await sendMessage(threadId, '这个对话还没绑定会话：先 /tasks 看列表，再 /use <编号>')
      return
    }
    const agent = agentOf(target.sessionId)
    if (!agent || typeof agent.followup !== 'function') {
      await sendMessage(threadId, '#' + shortId(target.sessionId) + ' 已不在运行，/tasks 重新选一个')
      return
    }
    const steer = text.startsWith('!')
    const payload = steer ? text.slice(1).trim() : text
    const input = { role: 'user', content: [{ type: 'text', text: payload }] }
    try {
      if (steer) agent.steer(input)
      else agent.followup(input)
      await sendMessage(threadId, (steer ? '已纠偏 ' : '已投递 ') + '#' + shortId(target.sessionId))
    } catch (error) {
      await sendMessage(threadId, '投递失败：' + String(error && error.message ? error.message : error))
    }
  }

  async function pollOnce() {
    const updates = await api.getUpdates(offset)
    for (const update of updates) {
      if (typeof update.update_id === 'number' && update.update_id >= offset) offset = update.update_id + 1
      try { await handleUpdate(update) } catch (error) {
        if (log && log.warn) log.warn('[wecom-notify] TG update 处理失败: ' + String(error))
      }
    }
    if (updates.length > 0) store.set('offset', offset)
    return updates.length
  }

  async function loop() {
    if (!running) return
    try {
      const count = await pollOnce()
      if (typeof diag === 'function') diag({ stage: 'polling', updates: count, offset })
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      if (log && log.warn) log.warn('[wecom-notify] TG 轮询失败: ' + message)
      if (typeof diag === 'function') diag({ stage: 'poll-error', lastError: message, offset })
      await new Promise((resolve) => setTimeout(resolve, 5000))
    }
    if (running) timer = setTimeout(() => { void loop() }, 200)
  }

  return {
    start() {
      if (running) return
      running = true
      if (log && log.info) log.info('[wecom-notify] TG 入站控制已启动（长轮询）')
      void loop()
    },
    stop() {
      running = false
      if (timer) clearTimeout(timer)
    },
    handleUpdate,
    resolveTarget,
  }
}