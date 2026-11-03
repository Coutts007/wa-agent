// Small helpers for WhatsApp message shapes and JIDs. No Baileys import here,
// so everything in this file can be unit-tested without the library installed.

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
]

/** Strip wrapper layers (ephemeral, view-once, ...) to reach the real content. */
export function unwrap(message) {
  let m = message
  for (let i = 0; i < 5 && m; i++) {
    const key = WRAPPERS.find((k) => m[k]?.message)
    if (!key) break
    m = m[key].message
  }
  return m
}

const IGNORED_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

/** First meaningful key of a message object, e.g. "conversation" or "imageMessage". */
export function contentType(message) {
  if (!message) return undefined
  return Object.keys(message).find((k) => !IGNORED_KEYS.has(k))
}

/** Text content of a message: body, caption, or button/list selection. */
export function extractText(message) {
  const m = unwrap(message) ?? {}
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ).trim()
}

/** Coarse classification used by the router and the status store. */
export function kindOf(message) {
  const t = contentType(unwrap(message))
  switch (t) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text'
    case 'imageMessage':
      return 'image'
    case 'videoMessage':
      return 'video'
    case 'audioMessage':
      return 'audio'
    case 'stickerMessage':
      return 'sticker'
    case 'documentMessage':
      return 'document'
    case 'protocolMessage':
    case 'reactionMessage':
    case 'pollUpdateMessage':
    case 'senderKeyDistributionMessage':
      return 'system'
    default:
      return t ? 'other' : 'empty'
  }
}

/** "254712345678" from "254712345678:12@s.whatsapp.net" or "254712345678@lid". */
export const jidUser = (jid = '') => String(jid).split('@')[0].split(':')[0]
export const jidServer = (jid = '') => String(jid).split('@')[1] ?? ''
export const isGroup = (jid) => jidServer(jid) === 'g.us'
export const isStatusJid = (jid) => jid === 'status@broadcast'
export const isNewsletter = (jid) => jidServer(jid) === 'newsletter'

/** Baileys timestamps arrive as seconds, as a number or a Long. Normalise to ms. */
export function tsToMs(ts) {
  if (ts == null) return Date.now()
  const n = typeof ts === 'object' && typeof ts.toNumber === 'function' ? ts.toNumber() : Number(ts)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n > 1e12 ? n : n * 1000
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const truncate = (s = '', n = 100) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function timeAgo(ms) {
  const diff = Math.max(0, Date.now() - ms)
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
