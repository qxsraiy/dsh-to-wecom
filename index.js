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


// ── 启动探针：写到系统 TEMP，用来确认模块是否被加载、apply 是否执行
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
const BOOT_LOG = (tmpdir() || '.') + '/dsh-wecom-notify-boot.log'
export function bootMark(stage, extra) {
  try {
    appendFileSync(BOOT_LOG, new Date().toISOString() + ' ' + stage + (extra ? (' ' + JSON.stringify(extra)) : '') + '\n', 'utf8')
  } catch (error) { /* 探针失败不影响主流程 */ }
}
bootMark('module-load', { pid: process.pid })

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
  toolReport: 'off',    // off 默认不报 | turn 汇总进每轮通知 | live 每次工具结果单独发
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
  cfg.toolReport = ['turn', 'live', 'off'].includes(cfg.toolReport) ? cfg.toolReport : DEFAULTS.toolReport
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

/** TG 里对审批的回复词：返回 'allow' / 'deny' / null。 */
export function matchApprovalReply(text) {
  const value = String(text == null ? '' : text).trim()
  if (/^(y|yes|ok|同意|允许|通过)$/i.test(value)) return 'allow'
  if (/^(n|no|拒绝|不允许|驳回)$/i.test(value)) return 'deny'
  return null
}

export function apply(ctx, config = {}) {
  bootMark('apply-enter', { pid: process.pid, provider: config && config.provider })
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
  const diagFile = join(queueDir, 'inbound-state.json')

  function diag(patch) {
    bootMark('diag-call', { stage: patch && patch.stage })
    void (async () => {
      try {
        await mkdir(queueDir, { recursive: true })
        let prev = {}
        try { prev = JSON.parse(await readFile(diagFile, 'utf8')) } catch (error) { /* 第一次 */ }
        const next = { ...prev, ...patch, at: new Date().toISOString(), version: '0.15.0' }
        await writeFile(diagFile, JSON.stringify(next, null, 2) + '\n', 'utf8')
      } catch (error) { bootMark('diag-error', { message: String(error && error.message ? error.message : error) }) }
    })()
  }
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
    setName(sessionId, name) {
      prefs.topicNames = prefs.topicNames || {}
      prefs.topicNames[sessionId] = name
      savePrefs()
    },
  }

  /** 会话标题变了 -> 跟着改 Telegram 话题名（只有已建过话题的会话才改）。 */
  function renameTelegramTopic(sessionId, title) {
    const threadId = prefs.topics && prefs.topics[sessionId]
    if (!threadId || !title) return
    prefs.topicNames = prefs.topicNames || {}
    if (prefs.topicNames[sessionId] === title) return
    prefs.topicNames[sessionId] = title
    savePrefs()
    const effective = { ...cfg, ...settings }
    if (!effective.telegramToken || !effective.telegramChatId) {
      diag({ stage: 'skip-missing-config', hasToken: Boolean(effective.telegramToken), hasChat: Boolean(effective.telegramChatId) })
      return
    }
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
    for (const key of Object.keys(cfg)) {
      if (key === 'provider') continue
      if (typeof merged[key] === 'string' || typeof merged[key] === 'number' || typeof merged[key] === 'boolean') values[key] = merged[key]
    }
    for (const field of SECRET_FIELDS) {
      if (merged[field]) values[field] = '***'
      else values[field] = merged[field] === undefined ? '' : merged[field]
    }
    return { provider: merged.provider, values, profiles: settings.profiles || {} }
  }

  function stateOf(session) {
    const id = String(session && session.id ? session.id : 'unknown')
    let s = state.get(id)
    if (!s) {
      s = { id, title: '', cwd: '', turn: 0, turnStart: 0, lastText: '', texts: [], toolCalls: 0, steps: 0, lastError: '', tools: [], firstUserText: '' }
      state.set(id, s)
    }
    lastSessionId = id
    if (!s.cwd && session && session.header && session.header.cwd) s.cwd = String(session.header.cwd)
    if (s.cwd) {
      const known = sessions.get(id)
      if (!known || known.cwd !== s.cwd) sessions.set(id, { cwd: s.cwd, title: known ? known.title : '', firstUserText: known ? known.firstUserText : '' })
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
    const active = { ...cfg, ...settings }
    const maxBytes = active.provider === 'telegram'
      ? 3900                      // Telegram 单条上限 4096 字节
      : (cfg.format === 'markdown' ? 3800 : 1800)
    const parts = packLines(content, maxBytes)
    const total = parts.length
    for (let i = 0; i < total; i += 1) {
      const prefix = total > 1 ? '[' + (i + 1) + '/' + total + '] ' : ''
      queue.push({ content: prefix + parts[i], attempts: 0, meta: jobMeta && jobMeta.meta, brief: jobMeta && jobMeta.brief })
    }
    void persist()
    void pump()
  }

  diag({ stage: 'apply-init', pid: process.pid })

  // ── 每个会话的推送开关（界面开关读写这里；按 sessionId 区分，同一目录的不同会话互不影响）
  const dataDir = cfg.queueDir || join(process.cwd(), '.dsh-wecom-notify')
  const prefsFile = join(dataDir, 'sessions.json')
  const prefs = { defaultEnabled: false, sessions: {}, topics: {}, bindings: {}, inbound: {} } // sessions: 开关; topics: sessionId->threadId
  const sessions = new Map() // sessionId -> { cwd, title }

  function titleFromSession(session) {
    try {
      if (!session || typeof session.snapshotEvents !== 'function') return ''
      const events = session.snapshotEvents()
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string' && event.data.title.trim()) {
          return event.data.title.trim()
        }
      }
    } catch (error) { /* 日志读不到就走回退 */ }
    return ''
  }

  function fallbackTitleFrom(s) {
    const text = String((s && (s.firstUserText || '')) || '').replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, 24) : ''
  }

  function sessionLabel(id, record) {
    const known = sessions.get(id)
    const title = (record && record.title) || (known && known.title) || (known && known.firstUserText ? String(known.firstUserText).slice(0, 24) : '') || ''
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
        if (parsed.topics && typeof parsed.topics === 'object') prefs.topics = parsed.topics
        if (parsed.bindings && typeof parsed.bindings === 'object') prefs.bindings = parsed.bindings
        if (parsed.inbound && typeof parsed.inbound === 'object') prefs.inbound = parsed.inbound
        if (parsed.topicNames && typeof parsed.topicNames === 'object') prefs.topicNames = parsed.topicNames
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
  // 启动时先读完 sessions.json / settings.json，避免界面读到默认值（重启后显示"全部关闭"就是这个原因）
  const readyPromise = Promise.all([loadSettings(), loadPrefs()])

  async function handleOp(input) {
    await readyPromise
    if (input && (input.op === 'config' || input.op === 'save-config')) {
      try {
        const raw = JSON.parse(await readFile(settingsFile, 'utf8'))
        if (raw && typeof raw === 'object') Object.assign(settings, raw)
      } catch (error) { /* 没有文件就用内存值 */ }
    }
    const op = String((input && input.op) || 'state')
    const sessionId = String((input && input.sessionId) || '')
    if (op === 'inbound') {
      let state = null
      try { state = JSON.parse(await readFile(diagFile, 'utf8')) } catch (error) { state = null }
      return { ok: true, running: Boolean(inbound), state }
    }
    if (op === 'config') return { ok: true, providers: PROVIDERS, ...maskedConfig() }
    if (op === 'save-config') {
      if (input.provider && PROVIDERS.includes(input.provider)) settings.provider = input.provider
      const values = input.values && typeof input.values === 'object' ? input.values : {}
      for (const [key, value] of Object.entries(values)) {
        if (key === 'provider') continue // 主通道只认 input.provider，避免 values 里的旧值把它盖回去
        if (SECRET_FIELDS.has(key) && (value === '***' || value === '')) continue
        settings[key] = value
      }
      // 配置单：按通道留一份快照，切走再切回能直接恢复
      settings.profiles = settings.profiles || {}
      settings.profiles[String(settings.provider || cfg.provider)] = { ...(settings.profiles[String(settings.provider || cfg.provider)] || {}), ...values }
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
    const service = agentServiceRef || agentsFacade
    const agent = service && service.get ? service.get(sessionId) : undefined
    const session = agent && agent.session
    if (!session) throw new Error('会话不在运行')
    titleService.rename(session, title)
  }

  // ── 话题生命周期 <-> 会话归档 ────────────────────────────────────────────
  function workspaceRegistry() {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    return registry && typeof registry.archiveSession === 'function' ? registry : undefined
  }

  async function archiveByTopic(sessionId, chatId, threadId) {
    if (!sessionId) { await tgSendToSafe(chatId, threadId, '这个话题没绑定 DSH 会话，先 /use 选一个'); return }
    const registry = workspaceRegistry()
    if (!registry) { await tgSendToSafe(chatId, threadId, '这个 DSH 没有工作区归档服务'); return }
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      await tgSendToSafe(chatId, threadId, '已归档 #' + String(sessionId).replace(/^session-/, '').slice(0, 4))
    } catch (error) {
      await tgSendToSafe(chatId, threadId, '归档失败：' + String(error && error.message ? error.message : error))
    }
  }

  async function unarchiveByTopic(sessionId, chatId, threadId) {
    if (!sessionId) { await tgSendToSafe(chatId, threadId, '这个话题没绑定 DSH 会话'); return }
    const registry = workspaceRegistry()
    if (!registry || typeof registry.unarchiveSession !== 'function') { await tgSendToSafe(chatId, threadId, '这个 DSH 没有反归档服务'); return }
    try {
      await registry.unarchiveSession(sessionId)
      await tgSendToSafe(chatId, threadId, '已解除归档 #' + String(sessionId).replace(/^session-/, '').slice(0, 4))
    } catch (error) {
      await tgSendToSafe(chatId, threadId, '解除归档失败：' + String(error && error.message ? error.message : error))
    }
  }

  async function topicCreated() {
    // 新建话题：DSH 侧建会话需要完整的工作区/预设上下文，这里只提示，不硬造会话。
  }

  async function tgSendToSafe(chatId, threadId, text) {
    const e = { ...cfg, ...settings }
    if (!e.telegramToken) return
    const body = { chat_id: chatId || e.telegramChatId, text, disable_web_page_preview: true }
    if (threadId) body.message_thread_id = Number(threadId)
    try { await telegramCall(e, 'sendMessage', body) } catch (error) { if (log.warn) log.warn('[wecom-notify] 话题回执发送失败: ' + String(error)) }
  }

  const agentsFacade = {
    get(id) {
      const service = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      return service && typeof service.get === 'function' ? service.get(id) : undefined
    },
  }

  function startTelegramInbound(agentService) {
    diag({ stage: 'start-attempt' })
    const effective = { ...cfg, ...settings }
    if (!effective.telegramInbound) {
      diag({ stage: 'skip-inbound-disabled' })
      return
    }
    if (!effective.telegramToken || !effective.telegramChatId) return
    if (inbound) return
    agentServiceRef = agentService || agentsFacade
    inbound = createTelegramInbound({
      cfg: effective,
      renameSession: renameSessionTitle,
      onTopicClosed: archiveByTopic,
      onTopicReopened: unarchiveByTopic,
      onTopicCreated: topicCreated,
      diag,
      resolveReply: resolveReplyFromTelegram,
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
    diag({ stage: 'started', provider: effective.provider, proxy: Boolean(effective.proxyUrl), chat: effective.telegramChatId })
  }


  // ── 审批（approval/request waterfall）与提问回传 ──────────────────────────
  const pendingApprovals = new Map() // key -> { sessionId, resolve, timer }
  const pendingQuestions = new Map() // callId -> { sessionId, questions, agent }

  function shortKey() {
    return Math.random().toString(36).slice(2, 6).toUpperCase()
  }

  function tgReady() {
    const e = { ...cfg, ...settings }
    return Boolean(e.telegramToken && e.telegramChatId && e.telegramInbound)
  }

  async function tgSendTo(sessionId, text) {
    const e = { ...cfg, ...settings }
    const threadId = prefs.topics && prefs.topics[sessionId]
    const body = { chat_id: e.telegramChatId, text, disable_web_page_preview: true }
    if (threadId) body.message_thread_id = Number(threadId)
    await telegramCall(e, 'sendMessage', body)
  }

  /** 用 telegram 话题里的 y/n 决定一次审批；超时 fail-closed。 */
  function awaitApproval(sessionId, req) {
    const key = shortKey()
    return new Promise((resolve) => {
      const settle = (outcome) => {
        const entry = pendingApprovals.get(key)
        if (!entry) return
        clearTimeout(entry.timer)
        pendingApprovals.delete(key)
        resolve(outcome)
      }
      const timer = setTimeout(() => settle('unavailable'), 180000)
      pendingApprovals.set(key, { sessionId, resolve: settle, timer })
      const lines = []
      lines.push('⚠️ 需要审批 [' + key + ']')
      lines.push('工具：' + String(req.toolName || '未知'))
      if (req.reason) lines.push('原因：' + String(req.reason).slice(0, 300))
      lines.push('')
      lines.push('回复 y = 允许一次 / n = 拒绝（180 秒不回复视为拒绝）')
      void tgSendTo(sessionId, lines.join('\n')).catch((error) => {
        if (log.warn) log.warn('[wecom-notify] 审批消息发送失败: ' + String(error))
      })
    })
  }

  const approvalOff = typeof ctx.on === 'function' ? ctx.on('approval/request', async (req, next) => {
    try {
      if (!tgReady()) return next()
      const sessionId = req && req.agent ? req.agent.id : ''
      if (!sessionId) return next()
      return await awaitApproval(sessionId, req)
    } catch (error) {
      if (log.warn) log.warn('[wecom-notify] 审批处理异常: ' + String(error))
      return 'unavailable'
    }
  }) : undefined

  /** 把 ask_user_question 的提问同步到 TG，并允许从 TG 回填（仅对已超时/继续态生效）。 */
  function noteQuestion(sessionId, callId, questions, agent) {
    if (!tgReady()) return
    pendingQuestions.set(callId, { sessionId, questions, agent })
    const lines = ['❓ 提问']
    for (const q of questions) {
      lines.push('· ' + String(q.question || '').slice(0, 200))
      if (Array.isArray(q.options)) q.options.forEach((opt, i) => lines.push('  ' + (i + 1) + ') ' + String(opt.label || opt)))
    }
    lines.push('')
    lines.push('在 TG 里直接回复答案（选项编号或文字）')
    void tgSendTo(sessionId, lines.join('\n')).catch((error) => {
      if (log.warn) log.warn('[wecom-notify] 提问消息发送失败: ' + String(error))
    })
  }

  /** 处理 TG 里对本会话审批/提问的回复；返回 true 表示已消费。 */
  async function resolveReplyFromTelegram(sessionId, text) {
    const value = String(text || '').trim()
    if (!value || !sessionId) return false
    for (const [key, entry] of pendingApprovals) {
      if (entry.sessionId !== sessionId) continue
      const verdict = matchApprovalReply(value)
      if (verdict === null) continue
      entry.resolve(verdict === 'allow' ? 'allowed-once' : 'rejected')
      return true
    }
    for (const [callId, entry] of pendingQuestions) {
      if (entry.sessionId !== sessionId) continue
      const answers = entry.questions.map((q) => {
        const options = Array.isArray(q.options) ? q.options : []
        const index = Number(value)
        if (Number.isInteger(index) && index >= 1 && index <= options.length) {
          const label = options[index - 1].label || options[index - 1]
          return { id: q.id, selected: [String(label)] }
        }
        return { id: q.id, selected: [], custom: value }
      })
      const service = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined
      if (!service || typeof service.answer !== 'function') {
        if (log.warn) log.warn('[wecom-notify] 没有 userQuestions 服务，无法回填提问')
        return false
      }
      const attempt = async (left) => {
        try {
          const accepted = service.answer(entry.agent, callId, { answers })
          if (accepted) {
            pendingQuestions.delete(callId)
            try { await tgSendTo(sessionId, '已回答提问') } catch (error) { /* ignore */ }
            return true
          }
        } catch (error) {
          if (log.warn) log.warn('[wecom-notify] 回答提问失败: ' + String(error))
        }
        if (left <= 0) return false
        await new Promise((resolve) => setTimeout(resolve, 5000))
        return await attempt(left - 1)
      }
      void attempt(12)
      return true
    }
    return false
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
      title: s.title || fallbackTitleFrom(s) || ('会话 #' + (s.id.replace(/^session-/, '').slice(0, 4))),
      turn: s.turn || 0,
      tools: s.toolCalls || 0,
      cwd: s.cwd || '-',
      error: info.kind === 'error' && s.lastError ? s.lastError : '',
      summary: capped,
    }
  }


  function toolLines(s) {
    if (cfg.toolReport === 'off') return []
    if (!Array.isArray(s.tools) || s.tools.length === 0) return []
    const rows = s.tools.slice(-12).map((item) => {
      const mark = item.status === 'error' ? '✗' : (item.status === 'running' ? '…' : '✓')
      const ms = item.ms ? (' ' + (item.ms / 1000).toFixed(1) + 's') : ''
      const tail = item.output ? (' · ' + item.output.slice(0, 120)) : ''
      return '· ' + item.name + ' ' + mark + ms + tail
    })
    if (s.tools.length > 12) rows.unshift('· 前面还有 ' + (s.tools.length - 12) + ' 次调用')
    return ['', '工具：', ...rows]
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
    lines.push(...toolLines(s))
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
    lines.push(...toolLines(s))
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
        s.tools = []
        return
      }
      if (event.type === 'step/start') { s.steps += 1; return }
      if (event.type === 'user/message') {
        const payload = event.data && (event.data.message || event.data)
        const blocks = payload && Array.isArray(payload.content) ? payload.content : []
        const text = blocks.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join(' ').trim()
        if (text && !s.firstUserText) {
          s.firstUserText = text
          const known = sessions.get(s.id) || { cwd: s.cwd, title: '' }
          sessions.set(s.id, { cwd: known.cwd, title: known.title, firstUserText: text })
        }
        return
      }
      if (event.type === 'assistant/message') {
        const text = messageText(event.data && event.data.message)
        if (text.trim()) {
          s.lastText = text
          s.texts.push(text.trim())
        }
        return
      }
      if (event.type === 'tool/call') {
        s.toolCalls += 1
        const callData = event.data || {}
        const callName = String(callData.name || callData.tool || (callData.message && callData.message.name) || 'tool')
        const callId = String(callData.callId || callData.id || (callData.message && callData.message.toolCallId) || '')
        s.tools.push({ callId, name: callName, started: Date.now(), status: 'running', output: '' })
        const data = event.data || {}
        if (data.name === 'ask_user_question' && data.callId) {
          const questions = (data.args && Array.isArray(data.args.questions)) ? data.args.questions : []
          const agent = agentServiceRef && agentServiceRef.get ? agentServiceRef.get(s.id) : undefined
          if (questions.length) noteQuestion(s.id, data.callId, questions, agent)
        }
        return
      }
      if (event.type === 'tool/result') {
        const data = event.data || {}
        const message = data.message || {}
        const callId = String(message.toolCallId || data.callId || '')
        const record = s.tools.find((item) => item.callId && item.callId === callId) || s.tools[s.tools.length - 1]
        if (record) {
          const blocks = Array.isArray(message.content) ? message.content : (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [])
          const output = blocks.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join(' ')
          const failed = Boolean(message.isError || data.isError || (data.error && data.error.message))
          record.status = failed ? 'error' : 'ok'
          record.output = (failed && data.error && data.error.message ? String(data.error.message) : output).replace(/\s+/g, ' ').trim().slice(0, 200)
          record.ms = Date.now() - (record.started || Date.now())
          if (cfg.toolReport === 'live') {
            const shortId = s.id.replace(/^session-/, '').slice(0, 4)
            enqueue('⚙ #' + shortId + ' ' + record.name + (failed ? ' ✗ ' : ' ✓ ') + (record.output ? record.output.slice(0, 160) : ''), {
              meta: { title: s.title || 'DSH', sessionId: s.id, project: s.cwd, level: failed ? 'error' : 'info' },
              brief: '⚙ #' + shortId + ' ' + record.name + (failed ? ' ✗' : ' ✓'),
            })
          }
        }
        return
      }
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
          // 会话真名优先：每轮都从日志里取最新标题（实时事件可能没赶上）
          const fromLog = titleFromSession(session)
          if (fromLog && fromLog !== s.title) s.title = fromLog
          const shortId = s.id.replace(/^session-/, '').slice(0, 4)
          const title = s.title || fallbackTitleFrom(s) || ('会话 #' + shortId)
          renameTelegramTopic(s.id, title)
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

  void readyPromise.then(() => {
    bootMark('ready', { defaultEnabled: prefs.defaultEnabled, sessions: Object.keys(prefs.sessions || {}).length })
    if (log.info) log.info('[wecom-notify] 配置已加载 · 默认推送=' + (prefs.defaultEnabled ? '开' : '关') + ' · 会话开关=' + Object.keys(prefs.sessions || {}).length + ' 条')
    try {
      startTelegramInbound(agentsFacade)
    } catch (error) {
      bootMark('inbound-start-error', { message: String(error && error.message ? error.message : error) })
      if (log.warn) log.warn('[wecom-notify] TG 入站启动失败: ' + String(error))
    }
  })

  if (log.info) log.info('[wecom-notify] 已加载 · 通道=' + (cfg.dryRun ? 'dry-run' : 'wecom-robot') + ' · 格式=' + cfg.format + ' · 模式=' + cfg.notifyOn)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try { if (typeof off === 'function') off() } catch (error) { /* ignore */ }
      try { if (inbound) inbound.stop() } catch (error) { /* ignore */ }
      try { if (typeof approvalOff === 'function') approvalOff() } catch (error) { /* ignore */ }
    })
  }
}

export const name = 'dsh-wecom-notify'