/**
 * 多通道发送：企业微信群机器人 / 企业微信应用消息 / 钉钉机器人 / Telegram / 邮件 / 自定义 webhook
 * 只用 Node 内置模块（fetch / net / tls / crypto）。
 */

import { createHmac } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

const TIMEOUT_MS = 15000

function timeoutSignal(ms = TIMEOUT_MS) {
  return AbortSignal.timeout(ms)
}

async function postJson(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: timeoutSignal(),
  })
  const raw = await res.text()
  let json
  try { json = JSON.parse(raw) } catch (error) { json = { raw } }
  return { status: res.status, ok: res.ok, json }
}

function failure(message, retryable = false, extra) {
  const error = new Error(message)
  error.retryable = retryable
  if (extra) error.detail = extra
  return error
}

// ── 企业微信群机器人 ───────────────────────────────────────────────────────
async function sendWecomRobot(cfg, text) {
  const key = String(cfg.wecomKey || '').trim()
  if (!key) throw failure('未配置企业微信群机器人 key')
  const base = String(cfg.wecomApiBase || 'https://qyapi.weixin.qq.com').replace(/\/+$/, '')
  const url = base + '/cgi-bin/webhook/send?key=' + encodeURIComponent(key)
  const body = cfg.format === 'markdown'
    ? { msgtype: 'markdown', markdown: { content: text } }
    : { msgtype: 'text', text: { content: text } }
  const { json } = await postJson(url, body)
  if (json.errcode !== 0) {
    throw failure('企业微信 errcode=' + json.errcode + ' ' + (json.errmsg || ''), json.errcode === 45009 || json.errcode === -1)
  }
  return { channel: 'wecom-robot', ok: true }
}

// ── 企业微信应用消息（需要「企业可信 IP」）─────────────────────────────────
const tokenCache = new Map() // corpId|secret -> { token, expiresAt }

async function wecomAccessToken(cfg) {
  const corpId = String(cfg.wecomCorpId || '').trim()
  const secret = String(cfg.wecomSecret || '').trim()
  if (!corpId || !secret) throw failure('未配置企业微信 CorpID / Secret')
  const cacheKey = corpId + '|' + secret
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' + encodeURIComponent(corpId) + '&corpsecret=' + encodeURIComponent(secret)
  const res = await fetch(url, { signal: timeoutSignal() })
  const json = await res.json()
  if (json.errcode !== 0) throw failure('企业微信 gettoken 失败 errcode=' + json.errcode + ' ' + (json.errmsg || ''), true)
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + Number(json.expires_in || 7200) * 1000 })
  return json.access_token
}

async function sendWecomApp(cfg, text) {
  const token = await wecomAccessToken(cfg)
  const agentId = Number(cfg.wecomAgentId || 0)
  if (!agentId) throw failure('未配置企业微信 AgentId')
  const body = {
    touser: String(cfg.wecomToUser || '@all'),
    msgtype: 'text',
    agentid: agentId,
    text: { content: text },
    safe: 0,
  }
  const { json } = await postJson('https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + encodeURIComponent(token), body)
  if (json.errcode !== 0) throw failure('企业微信 send 失败 errcode=' + json.errcode + ' ' + (json.errmsg || ''), json.errcode === 45009 || json.errcode === 42001)
  return { channel: 'wecom-app', ok: true }
}

// ── 钉钉机器人 ────────────────────────────────────────────────────────────
function dingTalkSign(secret) {
  const timestamp = Date.now()
  const stringToSign = timestamp + '\n' + secret
  const sign = createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64')
  return { timestamp, sign: encodeURIComponent(sign) }
}

async function sendDingTalk(cfg, text) {
  const token = String(cfg.dingToken || '').trim()
  if (!token) throw failure('未配置钉钉机器人 access_token')
  let url = 'https://oapi.dingtalk.com/robot/send?access_token=' + encodeURIComponent(token)
  const secret = String(cfg.dingSecret || '').trim()
  if (secret) {
    const signed = dingTalkSign(secret)
    url += '&timestamp=' + signed.timestamp + '&sign=' + signed.sign
  }
  const body = { msgtype: 'text', text: { content: text } }
  const { json } = await postJson(url, body)
  if (json.errcode !== 0) {
    throw failure('钉钉 errcode=' + json.errcode + ' ' + (json.errmsg || ''), json.errcode === 130101 || json.errcode === 130102)
  }
  return { channel: 'dingtalk', ok: true }
}

// ── Telegram ──────────────────────────────────────────────────────────────
async function sendTelegram(cfg, text) {
  const token = String(cfg.telegramToken || '').trim()
  const chatId = String(cfg.telegramChatId || '').trim()
  if (!token || !chatId) throw failure('未配置 Telegram bot token / chat_id')
  const url = 'https://api.telegram.org/bot' + token + '/sendMessage'
  const { json, status } = await postJson(url, { chat_id: chatId, text, disable_web_page_preview: true })
  if (!json.ok) {
    const desc = json.description || ('HTTP ' + status)
    throw failure('Telegram 失败: ' + desc, status === 429 || status >= 500)
  }
  return { channel: 'telegram', ok: true }
}

// ── 自定义 webhook ────────────────────────────────────────────────────────
function fillTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    const value = vars[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

async function sendWebhook(cfg, text, meta) {
  const url = String(cfg.webhookUrl || '').trim()
  if (!url) throw failure('未配置自定义 webhook 地址')
  const vars = {
    text,
    content: text,
    title: meta && meta.title ? meta.title : '',
    session: meta && meta.sessionId ? meta.sessionId : '',
    project: meta && meta.project ? meta.project : '',
    level: meta && meta.level ? meta.level : 'info',
    time: new Date().toISOString(),
  }
  let body
  if (cfg.webhookTemplate && String(cfg.webhookTemplate).trim()) {
    body = fillTemplate(cfg.webhookTemplate, vars)
  } else {
    body = JSON.stringify(vars)
  }
  const headers = { 'content-type': 'application/json' }
  if (cfg.webhookAuth) headers.authorization = String(cfg.webhookAuth)
  const res = await fetch(url, { method: 'POST', headers, body, signal: timeoutSignal() })
  if (!res.ok) throw failure('自定义 webhook HTTP ' + res.status, res.status >= 500 || res.status === 429)
  return { channel: 'webhook', ok: true }
}

// ── 邮件（最小 SMTP 客户端，支持 465 直连 TLS / 587 STARTTLS）──────────────
function base64(str) {
  return Buffer.from(str, 'utf8').toString('base64')
}

function smtpRead(socket, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { cleanup(); reject(failure('SMTP 读取超时', true)) }, timeoutMs)
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      // 多行响应：以 "250-" 续行，最后一行是 "250 "
      const lines = buffer.split('\r\n').filter(Boolean)
      if (lines.length === 0) return
      const last = lines[lines.length - 1]
      if (/^\d{3} /.test(last)) { cleanup(); resolve(buffer) }
    }
    const onError = (error) => { cleanup(); reject(failure('SMTP 连接错误: ' + error.message, true)) }
    function cleanup() {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

function smtpWrite(socket, line) {
  socket.write(line + '\r\n')
}

async function smtpCommand(socket, line, expect = /^[23]/) {
  smtpWrite(socket, line)
  const response = await smtpRead(socket)
  if (!expect.test(response)) throw failure('SMTP 命令失败: ' + line.split(' ')[0] + ' -> ' + response.trim().split('\r\n').pop(), true)
  return response
}

function openSocket(host, port, secure) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tlsConnect({ host, port, servername: host }, () => resolve(socket))
      : netConnect({ host, port }, () => resolve(socket))
    socket.setTimeout(TIMEOUT_MS, () => { socket.destroy(); reject(failure('SMTP 连接超时', true)) })
    socket.once('error', (error) => reject(failure('SMTP 连接失败: ' + error.message, true)))
  })
}

async function sendEmail(cfg, subject, text) {
  const host = String(cfg.mailHost || '').trim()
  const user = String(cfg.mailUser || '').trim()
  const pass = String(cfg.mailPass || '')
  const from = String(cfg.mailFrom || user).trim()
  const to = String(cfg.mailTo || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)
  if (!host || !user || !pass || to.length === 0) throw failure('邮件配置不完整（host/user/pass/to）')
  const port = Number(cfg.mailPort || (cfg.mailSecure === false ? 587 : 465))
  const secure = cfg.mailSecure !== false
  let socket = await openSocket(host, port, secure)
  try {
    await smtpRead(socket)
    await smtpCommand(socket, 'EHLO dsh-to-wecom')
    if (!secure) {
      await smtpCommand(socket, 'STARTTLS', /^220/)
      const upgraded = tlsConnect({ socket, servername: host })
      await new Promise((resolve, reject) => { upgraded.once('secureConnect', resolve); upgraded.once('error', reject) })
      socket = upgraded
      await smtpCommand(socket, 'EHLO dsh-to-wecom')
    }
    try {
      await smtpCommand(socket, 'AUTH LOGIN', /^334/)
      await smtpCommand(socket, base64(user), /^334/)
      await smtpCommand(socket, base64(pass), /^235/)
    } catch (error) {
      // 服务器不支持 AUTH LOGIN 时尝试 PLAIN
      const plain = base64('\u0000' + user + '\u0000' + pass)
      await smtpCommand(socket, 'AUTH PLAIN ' + plain, /^235/)
    }
    await smtpCommand(socket, 'MAIL FROM:<' + from + '>')
    for (const rcpt of to) await smtpCommand(socket, 'RCPT TO:<' + rcpt + '>')
    await smtpCommand(socket, 'DATA', /^354/)
    const headers = [
      'From: ' + from,
      'To: ' + to.join(', '),
      'Subject: =?UTF-8?B?' + base64(subject) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      'Date: ' + new Date().toUTCString(),
    ]
    const body = base64(text).replace(/(.{76})/g, '$1\r\n')
    socket.write(headers.join('\r\n') + '\r\n\r\n' + body + '\r\n.\r\n')
    const accepted = await smtpRead(socket)
    if (!/^250/.test(accepted)) throw failure('SMTP 投递被拒: ' + accepted.trim().split('\r\n').pop(), true)
    await smtpCommand(socket, 'QUIT', /^221/).catch(() => {})
    return { channel: 'email', ok: true }
  } finally {
    try { socket.end() } catch (error) { /* ignore */ }
  }
}

export const PROVIDERS = ['wecom-robot', 'wecom-app', 'dingtalk', 'telegram', 'email', 'webhook']

export async function sendNotification(cfg, text, meta = {}) {
  const provider = PROVIDERS.includes(cfg.provider) ? cfg.provider : 'wecom-robot'
  switch (provider) {
    case 'wecom-robot': return await sendWecomRobot(cfg, text)
    case 'wecom-app': return await sendWecomApp(cfg, text)
    case 'dingtalk': return await sendDingTalk(cfg, text)
    case 'telegram': return await sendTelegram(cfg, text)
    case 'email': return await sendEmail(cfg, meta.title ? ('[DSH] ' + meta.title) : '[DSH] 任务通知', text)
    case 'webhook': return await sendWebhook(cfg, text, meta)
    default: throw failure('未知的推送服务: ' + provider)
  }
}
