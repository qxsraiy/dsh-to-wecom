/**
 * dsh-wecom-notify —— 每一轮 AI 输出结束后把一条摘要推到企业微信群机器人。
 *
 * v0.2.0：默认走 text 纯文本（企业微信和微信里都能直接看，不会出现 markdown 源码），
 *         想用颜色/标题再切 format: markdown。
 * 设计：
 * - 只挂事件，不改模型上下文：观察 session/event 的 turn/end。
 * - 发送与主流程解耦：入队 + 串行闸门 + 指数退避，企业微信 20 条/分钟不会反噬 DSH。
 * - 失败不丢：队列落盘到 queueDir/pending.jsonl，重启后补发。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { PROVIDERS, deliverAll, sendNotification, telegramCall } from './notify.js'
import { createTelegramInbound } from './inbound.js'

const DEFAULTS = {
  enabled: true,
  // 推送服务：wecom-robot | wecom-app | dingtalk | telegram | email | webhook
  provider: 'wecom-robot',
  webhookUrl: '',
  webhookKey: '',
  // 主通道之外再推一条简报的镜像通道（例如 telegram 发全文、wecom-robot 只发一句）
  mirror: '',
  telegramApiBase: '',
  telegramToken: '',
  telegramChatId: '',
  telegramUserId: '',
  telegramTopics: true,
  telegramInbound: true,
  proxyUrl: '',
  format: 'text',        // text | markdown
  notifyOn: 'every-turn',
  includeSubagents: false,
  minGapMs: 3200,
  maxRetries: 5,
  textLimit: 0,          // 0 = 不截断（默认）；>0 时摘要按字符截断
  maxChars: 6000,        // 整条消息上限；超出按字节自动拆成多条 [i/n]
  queueDir: '',
  dryRun: false,
  controlPort: 8791,     // 本机控制接口（界面开关读写它），只绑 127.0.0.1
  controlEnabled: true,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function normalize(config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  cfg.webhookUrl = String(cfg.webhookUrl || '')
  cfg.webhookKey = String(cfg.webhookKey || process.env.WECOM_ROBOT_KEY || '')
  cfg.provider = PROVIDERS.includes(cfg.provider) ? cfg.provider : DEFAULTS.provider
  cfg.wecomKey = String(cfg.wecomKey || cfg.webhookKey || '')
  cfg.format = cfg.format === 'markdown' ? 'markdown' : 'text'
  cfg.minGapMs = Number.isFinite(Number(cfg.minGapMs)) ? Number(cfg.minGapMs) : DEFAULTS.minGapMs
  cfg.maxRetries = Number.isFinite(Number(cfg.maxRetries)) ? Number(cfg.maxRetries) : DEFAULTS.maxRetries
  cfg.textLimit = Number.isFinite(Number(cfg.textLimit)) ? Number(cfg.textLimit) : DEFAULTS.textLimit
  cfg.notifyOn = ['every-turn', 'completed', 'errors-only'].includes(cfg.notifyOn) ? cfg.notifyOn : DEFAULTS.notifyOn
  if (!cfg.webhookUrl && cfg.webhookKey) {
    cfg.webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=' + cfg.webhookKey
  }
  return cfg
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const total = Math.round(ms / 1000)
  if (total < 60) return total + 's'
  const m = Math.floor(total / 60)
  const rest = total % 60
  if (m < 60) return m + 'm' + String(rest).padStart(2, '0') + 's'
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'
}

function reasonOf(reason) {
  const kind = reason && reason.kind ? reason.kind : 'unknown'
  if (kind === 'completed') return { kind, label: '完成', color: 'info' }
  if (kind === 'aborted') return { kind, label: '被中断', color: 'warning' }
  if (kind === 'blocked') return { kind, label: '被拦截', color: 'warning' }
  if (kind === 'interrupted') return { kind, label: '中断', color: 'warning' }
  if (kind === 'error') {
    const code = reason && reason.error && reason.error.code ? ' (' + reason.error.code + ')' : ''
    return { kind, label: '失败' + code, color: 'warning' }
  }
  return { kind, label: kind, color: 'comment' }
}

function escapeMd(text) {
  return String(text == null ? '' : text).replace(/[<>]/g, (ch) => (ch === '<' ? '‹' : '›'))
}

export function apply(ctx, config = {}) {
  const cfg = normalize(config)
  const log = ctx && ctx.logger ? ctx.logger : console
  if (!cfg.enabled) {
    if (log.info) log.info('[wecom-notify] 已禁用（config.enabled=false）')
    return
  }
  if (cfg.dryRun) {
    if (log.info) log.info('[wecom-notify] dry-run 模式：只打日志不发送')
  }

  const state = new Map()
  const queue = []
  let pumping = null
  const queueDir = cfg.queueDir || join(process.cwd(), '.dsh-wecom-notify')
  const queueFile = join(queueDir, 'pending.jsonl')
  const settingsFile = join(queueDir, 'settings.json')
  // 面板里保存的推送配置；为空时用 patch 里的 config
  const settings = {}
  const SECRET_FIELDS = new Set(['wecomKey', 'wecomSecret', 'dingSecret', 'telegramToken', 'mailPass', 'webhookAuth'])
  let lastSessionId = ''

  async function loadSettings() {
    try {
      const parsed = JSON.parse(await readFile(settingsFile, 'utf8'))
      if (parsed && typeof parsed === 'object') Object.assign(settings, parsed)
    } catch (error) { /* 没有面板配置 */ }
  }

  function saveSettings() {
    void (async () => {
      try {
        await mkdir(queueDir, { recursive: true })
        await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')
      } catch (error) {
        if (log.warn) log.warn('[wecom-notify] 设置落盘失败: ' + String(error))
      }
    })()
  }

  const topicStore = {
    get(sessionId) { return prefs.topics && prefs.topics[sessionId] },
    set(sessionId, threadId) {
      prefs.topics = prefs.topics || {}
      prefs.topics[sessionId] = threadId
      savePrefs()
    },
  }

  /** 会话标题变了 -> 跟着改 Telegram 话题名（只有已建过话题的会话才改）。 */
  function renameTelegramTopic(sessionId, title) {
    const threadId = prefs.topics && prefs.topics[sessionId]
    if (!threadId) return
    const effective = { ...cfg, ...settings }
    if (!effective.telegramToken || !effective.telegramChatId) return
    if (effective.provider !== 'telegram' && effective.mirror !== 'telegram') return
    const shortId = String(sessionId).replace(/^session-/, '').slice(0, 4)
    const name = ('[#' + shortId + '] ' + String(title || '')).slice(0, 120)
    void telegramCall(effective, 'editForumTopic', {
      chat_id: effective.telegramChatId,
      message_thread_id: Number(threadId),
      name,
    }).then((result) => {
      if (!result.json || !result.json.ok) {
        if (log.warn) log.warn('[wecom-notify] 改话题名失败: ' + String(result.json && result.json.description ? result.json.description : ('HTTP ' + result.status)))
      } else if (log.info) {
        log.info('[wecom-notify] 话题名已同步: ' + name)
      }
    }).catch((error) => {
      if (log.warn) log.warn('[wecom-notify] 改话题名异常: ' + String(error))
    })
  }

  function maskedConfig() {
    const values = {}
    const merged = { ...cfg, ...settings }
    for (const key of Object.keys(cfg)) if (typeof merged[key] === 'string' || typeof merged[key] === 'number' || typeof merged[key] === 'boolean') values[key] = merged[key]
    for (const field of SECRET_FIELDS) {
      if (merged[field]) values[field] = '***'
      else values[field] = merged[field] === undefined ? '' : merged[field]
    }
    return { provider: merged.provider, values }
  }

  function stateOf(session) {
    const id = String(session && session.id ? session.id : 'unknown')
    let s = state.get(id)
    if (!s) {
      s = { id, title: '', cwd: '', turn: 0, turnStart: 0, lastText: '', texts: [], toolCalls: 0, steps: 0, lastError: '' }
      state.set(id, s)
    }
    lastSessionId = id
    if (!s.cwd && session && session.header && session.header.cwd) s.cwd = String(session.header.cwd)
    if (s.cwd) {
      const known = sessions.get(id)
      if (!known || known.cwd !== s.cwd) sessions.set(id, { cwd: s.cwd, title: known ? known.title : '' })
    }
    return s
  }

  async function send(content, meta, brief) {
    if (cfg.dryRun) {
      if (log.info) log.info('[wecom-notify][dry-run] ' + content.replace(/\n/g, ' | '))
      return
    }
    // patch 配置 < 面板设置（settings.json），面板里改的优先
    const effective = { ...cfg, ...settings }
    effective.provider = PROVIDERS.includes(effective.provider) ? effective.provider : cfg.provider
    effective.__topicStore = topicStore
    await deliverAll(effective, { full: content, brief: brief || content }, meta || {})
  }

  async function persist() {
    try {
      await mkdir(queueDir, { recursive: true })
      const body = queue.map((job) => JSON.stringify(job.content)).join('\n')
      await writeFile(queueFile, body + (body ? '\n' : ''), 'utf8')
    } catch (error) {
      if (log.warn) log.warn('[wecom-notify] 队列落盘失败: ' + String(error))
    }
  }

  function pump() {
    if (pumping) return pumping
    pumping = (async () => {
      while (queue.length > 0) {
        const job = queue[0]
        try {
          await send(job.content, job.meta, job.brief)
          queue.shift()
        } catch (error) {
          job.attempts += 1
          const retryable = error && error.retryable !== false
          if (job.attempts > cfg.maxRetries || !retryable) {
            if (log.warn) log.warn('[wecom-notify] 放弃发送（第 ' + job.attempts + ' 次）: ' + String(error && error.message ? error.message : error))
            queue.shift()
          } else {
            const wait = Math.min(60000, 3000 * Math.pow(2, job.attempts))
            if (log.info) log.info('[wecom-notify] 发送失败，' + wait + 'ms 后重试: ' + String(error && error.message ? error.message : error))
            await sleep(wait)
            continue
          }
        }
        await persist()
        await sleep(cfg.minGapMs)
      }
    })().finally(() => { pumping = null })
    return pumping
  }

  /** 按 UTF-8 字节切分（微信/企业微信的 text 上限是字节数，不是字符数）。 */
  function splitByChars(text, maxBytes) {
    const parts = []
    let current = ''
    let bytes = 0
    for (const ch of text) {
      const size = Buffer.byteLength(ch, 'utf8')
      if (bytes + size > maxBytes && current) {
        parts.push(current)
        current = ''
        bytes = 0
      }
      current += ch
      bytes += size
    }
    if (current) parts.push(current)
    return parts
  }

  /** 先按行打包，单行仍超限再按字符切；返回每条都合法的片段。 */
  function packLines(text, maxBytes) {
    const parts = []
    let current = ''
    for (const line of String(text).split('\n')) {
      const candidate = current ? current + '\n' + line : line
      if (Buffer.byteLength(candidate, 'utf8') > maxBytes && current) {
        parts.push(current)
        current = line
      } else {
        current = candidate
      }
    }
    if (current) parts.push(current)
    return parts.flatMap((part) => (Buffer.byteLength(part, 'utf8') > maxBytes ? splitByChars(part, maxBytes) : [part]))
  }

  function enqueue(content, jobMeta) {
    // 企业微信：text 2048 字节 / markdown 4096 字节。留余量，超长拆成多条并标 [i/n]。
    const maxBytes = cfg.format === 'markdown' ? 3800 : 1800
    const parts = packLines(content, maxBytes)
    const total = parts.length
    for (let i = 0; i < total; i += 1) {
      const prefix = total > 1 ? '[' + (i + 1) + '/' + total + '] ' : ''
      queue.push({ content: prefix + parts[i], attempts: 0, meta: jobMeta && jobMeta.meta, brief: jobMeta && jobMeta.brief })
    }
    void persist()
    void pump()
  }

  // ── 每个会话的推送开关（界面开关读写这里；按 sessionId 区分，同一目录的不同会话互不影响）
  const dataDir = cfg.queueDir || join(process.cwd(), '.dsh-wecom-notify')
  const prefsFile = join(dataDir, 'sessions.json')
  const prefs = { defaultEnabled: false, sessions: {} } // sessionId -> { enabled, title, cwd, updatedAt }
  const sessions = new Map() // sessionId -> { cwd, title }

  function sessionLabel(id, record) {
    const known = sessions.get(id)
    const title = (record && record.title) || (known && known.title) || ''
    const cwd = (record && record.cwd) || (known && known.cwd) || ''
    const shortId = String(id || '').replace(/^session-/, '').slice(0, 4) || '----'
    return { title: title || ('会话 #' + shortId), cwd, shortId }
  }

  function sessionState(id) {
    const key = String(id || '')
    const record = key ? prefs.sessions[key] : undefined
    const label = sessionLabel(key, record)
    const enabled = record && typeof record.enabled === 'boolean' ? record.enabled : prefs.defaultEnabled
    return { sessionId: key, title: label.title, shortId: label.shortId, cwd: label.cwd, enabled, hasOverride: Boolean(record) }
  }

  function shouldNotify(id) {
    return sessionState(id).enabled
  }

  async function loadPrefs() {
    try {
      const parsed = JSON.parse(await readFile(prefsFile, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.defaultEnabled === 'boolean') prefs.defaultEnabled = parsed.defaultEnabled
        if (parsed.sessions && typeof parsed.sessions === 'object') prefs.sessions = parsed.sessions
      }
    } catch (error) { /* 首次运行没有配置文件 */ }
  }

  let saveTimer = null
  function savePrefs() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void (async () => {
        try {
          await mkdir(dataDir, { recursive: true })
          await writeFile(prefsFile, JSON.stringify(prefs, null, 2) + '\n', 'utf8')
        } catch (error) {
          if (log.warn) log.warn('[wecom-notify] 偏好落盘失败: ' + String(error))
        }
      })()
    }, 120)
  }

  function snapshot() {
    const ids = new Set([...sessions.keys(), ...Object.keys(prefs.sessions)])
    const list = [...ids].map((id) => sessionState(id))
    list.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)))
    return { defaultEnabled: prefs.defaultEnabled, sessions: list }
  }

  function rememberSession(id, patch) {
    const key = String(id || '')
    if (!key) return
    const known = sessions.get(key) || { cwd: '', title: '' }
    sessions.set(key, { cwd: patch.cwd || known.cwd, title: patch.title || known.title })
  }

  // ── 控制面：挂到 DSH 自己的 /api 上（同源、带 cookie 认证，不需要任何额外端口）
  async function handleOp(input) {
    const op = String((input && input.op) || 'state')
    const sessionId = String((input && input.sessionId) || '')
    if (op === 'config') return { ok: true, providers: PROVIDERS, ...maskedConfig() }
    if (op === 'save-config') {
      if (input.provider && PROVIDERS.includes(input.provider)) settings.provider = input.provider
      const values = input.values && typeof input.values === 'object' ? input.values : {}
      for (const [key, value] of Object.entries(values)) {
        if (SECRET_FIELDS.has(key) && (value === '***' || value === '')) continue
        settings[key] = value
      }
      saveSettings()
      const merged = { ...cfg, ...settings }
      const warning = merged.mirror && merged.mirror === merged.provider
        ? '主通道和镜像通道是同一个（' + String(merged.provider) + '），镜像会被跳过；镜像请选另一个通道'
        : ''
      return { ok: true, warning, providers: PROVIDERS, ...maskedConfig() }
    }
    if (op === 'test') {
      const effective = { ...cfg, ...settings }
      const text = '[DSH] 测试通知 · ' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '\n如果你收到这条，说明通道配好了。'
      try {
        const result = await sendNotification(effective, text, { title: '测试通知', level: 'test' })
        return { ok: true, result }
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    }
    if (op === 'current') {
      if (lastSessionId) rememberSession(lastSessionId, {})
      return { ok: true, sessionId: lastSessionId, session: lastSessionId ? sessionState(lastSessionId) : null, state: snapshot() }
    }
    if (op === 'default') {
      prefs.defaultEnabled = input.enabled !== false
      savePrefs()
      return { ok: true, state: snapshot() }
    }
    if (op === 'reset') {
      if (sessionId) delete prefs.sessions[sessionId]
      savePrefs()
      return { ok: true, state: snapshot() }
    }
    if (op === 'toggle' || op === 'set') {
      if (!sessionId) return { ok: false, error: 'missing_session_id' }
      const current = sessionState(sessionId)
      const enabled = op === 'toggle' ? !current.enabled : (input.enabled !== false)
      const label = sessionLabel(sessionId, null)
      prefs.sessions[sessionId] = { enabled, title: label.title, cwd: label.cwd, updatedAt: Date.now() }
      savePrefs()
      return { ok: true, session: sessionState(sessionId), state: snapshot() }
    }
    // 默认 state
    if (sessionId) rememberSession(sessionId, {})
    return { ok: true, default: prefs.defaultEnabled, session: sessionId ? sessionState(sessionId) : null, state: snapshot() }
  }

  // ── Telegram 入站控制（长轮询）────────────────────────────────────────────
  let inbound = null
  let agentServiceRef = null
  async function renameSessionTitle(sessionId, title) {
    const titleService = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    if (!titleService || typeof titleService.rename !== 'function') throw new Error('会话标题服务不可用')
    const agent = agentServiceRef && agentServiceRef.get ? agentServiceRef.get(sessionId) : undefined
    const session = agent && agent.session
    if (!session) throw new Error('会话不在运行')
    titleService.rename(session, title)
  }

  function startTelegramInbound(agentService) {
    const effective = { ...cfg, ...settings }
    if (!effective.telegramInbound) return
    if (!effective.telegramToken || !effective.telegramChatId) return
    if (inbound) return
    agentServiceRef = agentService
    inbound = createTelegramInbound({
      cfg: effective,
      renameSession: renameSessionTitle,
      log,
      agents: agentService,
      sessions,
      prefs,
      savePrefs,
      store: {
        get(key) { return prefs.inbound ? prefs.inbound[key] : undefined },
        set(key, value) { prefs.inbound = prefs.inbound || {}; prefs.inbound[key] = value; savePrefs() },
      },
      api: {
        async getUpdates(offset) {
          const result = await telegramCall(effective, 'getUpdates', { offset, timeout: 10, allowed_updates: ['message'] })
          if (!result.json || !result.json.ok) throw new Error('getUpdates 失败: ' + (result.json && result.json.description ? result.json.description : ('HTTP ' + result.status)))
          return result.json.result || []
        },
      },
      async sendMessage(threadId, text) {
        const body = { chat_id: effective.telegramChatId, text, disable_web_page_preview: true }
        if (threadId) body.message_thread_id = threadId
        await telegramCall(effective, 'sendMessage', body)
      },
    })
    inbound.start()
  }

  function registerControlRoute(routeCtx) {
    const registry = routeCtx && routeCtx.connection && routeCtx.connection.fetch
    if (!registry || typeof registry.register !== 'function') {
      if (log.warn) log.warn('[wecom-notify] 没有 connection.fetch 服务，界面开关不可用（通知发送不受影响）')
      return
    }
    registry.register({
      path: '/api/dsh-to-wecom',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let input = {}
        try { input = await request.json() } catch (error) { input = {} }
        try {
          return Response.json(await handleOp(input))
        } catch (error) {
          return Response.json({ ok: false, error: String(error && error.message ? error.message : error) }, { status: 500 })
        }
      },
    })
    if (log.info) log.info('[wecom-notify] 控制接口已挂到 /api/dsh-to-wecom（同源，无额外端口）')
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['connection'], (routeCtx) => {
        try { registerControlRoute(routeCtx) } catch (error) { if (log.warn) log.warn('[wecom-notify] 控制路由注册失败: ' + String(error)) }
      })
    } catch (error) {
      registerControlRoute(ctx)
    }
  } else {
    registerControlRoute(ctx)
  }

  function facts(s, info) {
    const project = s.cwd ? basename(s.cwd) : 'DSH'
    const shortId = s.id.replace(/^session-/, '').slice(0, 4) || '----'
    const elapsed = humanDuration(Date.now() - (s.turnStart || Date.now()))
    const raw = (Array.isArray(s.texts) && s.texts.length ? s.texts.join('\n\n') : String(s.lastText || ''))
    const summary = raw.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    const capped = cfg.maxChars > 0 && summary.length > cfg.maxChars ? summary.slice(0, cfg.maxChars) + ' …(已截断)' : summary
    return {
      project,
      shortId,
      elapsed,
      title: s.title || project,
      turn: s.turn || 0,
      tools: s.toolCalls || 0,
      cwd: s.cwd || '-',
      error: info.kind === 'error' && s.lastError ? s.lastError : '',
      summary: capped,
    }
  }

  function composeText(s, info) {
    const f = facts(s, info)
    const lines = []
    lines.push('【' + info.label + '】' + f.title)
    lines.push('任务 #' + f.shortId + ' · 第 ' + f.turn + ' 轮 · ' + f.elapsed + ' · 工具 ' + f.tools + ' 次')
    lines.push('目录 ' + f.cwd)
    if (f.error) lines.push('错误 ' + f.error)
    if (f.summary) {
      lines.push('')
      lines.push(f.summary)
    }
    return lines.join('\n')
  }

  function composeMarkdown(s, info) {
    const f = facts(s, info)
    const lines = []
    lines.push('## ' + escapeMd(f.title) + ' · <font color="' + info.color + '">' + info.label + '</font>')
    lines.push('> 任务 #' + f.shortId + ' · 第 ' + f.turn + ' 轮 · ' + f.elapsed + ' · 工具 ' + f.tools + ' 次')
    lines.push('> 目录 ' + escapeMd(f.cwd))
    if (f.error) lines.push('> 错误 ' + escapeMd(f.error))
    if (f.summary) {
      lines.push('')
      lines.push(escapeMd(f.summary))
    }
    return lines.join('\n')
  }

  const compose = cfg.format === 'markdown' ? composeMarkdown : composeText

  const off = ctx.on('session/event', (session, event) => {
    try {
      if (!event || !event.type) return
      const s = stateOf(session)
      if (event.type === 'session/title') {
        const title = event.data && (event.data.title || event.data.text)
        if (typeof title === 'string' && title.trim()) {
          const changed = s.title !== title.trim()
          s.title = title.trim()
          if (changed) renameTelegramTopic(s.id, s.title)
          const known = sessions.get(s.id)
          sessions.set(s.id, { cwd: s.cwd || (known ? known.cwd : ''), title: s.title })
        }
        return
      }
      if (event.type === 'turn/start') {
        s.turn = Number(event.data && event.data.turn != null ? event.data.turn : s.turn + 1)
        s.turnStart = Date.now()
        s.lastText = ''
        s.texts = []
        s.toolCalls = 0
        s.steps = 0
        s.lastError = ''
        return
      }
      if (event.type === 'step/start') { s.steps += 1; return }
      if (event.type === 'assistant/message') {
        const text = messageText(event.data && event.data.message)
        if (text.trim()) {
          s.lastText = text
          s.texts.push(text.trim())
        }
        return
      }
      if (event.type === 'tool/call') { s.toolCalls += 1; return }
      if (event.type === 'turn/end') {
        const reason = (event.data && event.data.reason) || { kind: 'completed' }
        if (event.data && event.data.turn) s.turn = Number(event.data.turn)
        if (reason && reason.error && reason.error.message) s.lastError = String(reason.error.message).slice(0, 160)
        const kind = reason.kind || 'completed'
        const isSub = Boolean(session && session.header && (session.header.parentSessionId || session.header.parentAgentId))
        const wanted = cfg.notifyOn === 'every-turn'
          || (cfg.notifyOn === 'completed' && kind === 'completed')
          || (cfg.notifyOn === 'errors-only' && kind === 'error')
        const sessionAllowed = shouldNotify(s.id)
        if (wanted && sessionAllowed && (cfg.includeSubagents || !isSub)) {
          const info = reasonOf(reason)
          const shortId = s.id.replace(/^session-/, '').slice(0, 4)
          const title = s.title || basename(s.cwd || '') || 'DSH'
          const brief = '[#' + shortId + '] ' + title + ' · ' + info.label + '（详情见 ' + (String(({ ...cfg, ...settings }).provider) === 'telegram' ? 'TG' : '主通道') + '）'
          enqueue(compose(s, info), { meta: { title, sessionId: s.id, project: s.cwd, level: reason.kind || 'completed' }, brief })
        }
      }
    } catch (error) {
      if (log.warn) log.warn('[wecom-notify] session/event 处理异常: ' + String(error && error.message ? error.message : error))
    }
  })

  void (async () => {
    try {
      const raw = await readFile(queueFile, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { queue.push({ content: JSON.parse(trimmed), attempts: 0 }) } catch (error) { /* 跳过坏行 */ }
      }
      if (queue.length) {
        if (log.info) log.info('[wecom-notify] 补发 ' + queue.length + ' 条离线通知')
        void pump()
      }
    } catch (error) { /* 首次启动没有队列文件 */ }
  })()

  if (log.info) log.info('[wecom-notify] 已加载 · 通道=' + (cfg.dryRun ? 'dry-run' : 'wecom-robot') + ' · 格式=' + cfg.format + ' · 模式=' + cfg.notifyOn)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { if (typeof off === 'function') off() } catch (error) { /* ignore */ }
      try { if (inbound) inbound.stop() } catch (error) { /* ignore */ }
    })
  }
}

export const name = 'dsh-wecom-notify'