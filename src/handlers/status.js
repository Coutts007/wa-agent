// Captures contacts' statuses (24h stories) as they arrive, describes media with a
// vision model, and ranks stored statuses against what you feel like watching.

import { extractText, jidUser, kindOf, timeAgo, truncate, tsToMs, unwrap } from '../utils.js'
import { describeStatusPrompt, rankSystem, rankUser } from '../prompts.js'

const DAY_MS = 24 * 60 * 60 * 1000

export async function captureStatus(ctx, msg) {
  const { wa, db, llm, config, logger } = ctx
  const key = msg.key
  const kind = kindOf(msg.message)
  if (kind === 'system' || kind === 'empty') return
  const message = unwrap(msg.message)

  const posterJid = key.participant || key.remoteJid
  if (msg.pushName) db.upsertContact(posterJid, msg.pushName)
  const posterName = msg.pushName || db.contactName(posterJid) || jidUser(posterJid)
  const postedAt = tsToMs(msg.messageTimestamp)
  const caption = extractText(msg.message)

  let description = null
  if (config.status.describeMedia && (kind === 'image' || kind === 'video')) {
    try {
      const img = await mediaForVision(wa, msg, message, kind)
      if (img) description = await llm.describeImage({ ...img, prompt: describeStatusPrompt(kind, caption) })
    } catch (err) {
      logger.warn({ err: err?.message, posterName }, 'could not describe status media')
    }
  }

  const saved = db.saveStatus({
    id: key.id,
    posterJid,
    posterName,
    kind,
    caption,
    description,
    postedAt,
    expiresAt: postedAt + DAY_MS,
    rawKey: key,
  })
  if (!saved) return
  logger.info({ posterName, kind, caption: truncate(caption, 40) }, 'captured status')
  if (config.status.autoView) {
    await wa.markRead([key])
    db.markStatusViewed(key.id)
  }
}

/** Returns { mimeType, data } for the vision model, or null if nothing usable. */
async function mediaForVision(wa, msg, message, kind) {
  if (kind === 'image') {
    const buf = await wa.downloadMedia(msg)
    if (!buf?.length) return null
    return { mimeType: message.imageMessage?.mimetype || 'image/jpeg', data: Buffer.from(buf).toString('base64') }
  }
  // Videos: use the embedded thumbnail (cheap, works with every provider). Swap for a
  // full download + a video-capable model if you want deeper understanding.
  const thumb = message.videoMessage?.jpegThumbnail
  if (!thumb?.length) return null
  return { mimeType: 'image/jpeg', data: Buffer.from(thumb).toString('base64') }
}

function summaryOf(r) {
  const bits = []
  if (r.caption) bits.push(`"${truncate(r.caption, 90)}"`)
  if (r.description) bits.push(truncate(r.description, 140))
  return bits.join(' — ') || '(no text)'
}

export function listStatuses(ctx, limit = 25) {
  const rows = ctx.db.activeStatuses(limit)
  if (!rows.length) {
    return 'No statuses captured in the last 24 hours yet. They are captured as contacts post them while the bot is running.'
  }
  const lines = rows.map(
    (r, i) => `${i + 1}. ${r.poster_name} · ${r.kind} · ${timeAgo(r.posted_at)}\n   ${summaryOf(r)}`,
  )
  return `Statuses from the last 24h (newest first):\n${lines.join('\n')}`
}

export async function recommendStatuses(ctx, request) {
  const rows = ctx.db.activeStatuses(120)
  if (!rows.length) return listStatuses(ctx)
  const lines = rows.map(
    (r, i) => `[#${i + 1}] ${r.poster_name} | ${r.kind} | ${timeAgo(r.posted_at)} | ${summaryOf(r)}`,
  )
  const out = await ctx.llm.chat({
    system: rankSystem(ctx.config.ownerName),
    messages: [{ role: 'user', content: rankUser(request, lines) }],
    maxTokens: 700,
  })
  return out || 'I could not rank them right now; try /statuses for the raw list.'
}
