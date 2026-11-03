// Replies to other people's messages while you're away.

import { isGroup, jidUser } from '../utils.js'
import { autoReplySystem } from '../prompts.js'

export function autoReplyEnabled(ctx) {
  const fallback = ctx.config.autoReply.enabled ? 'on' : 'off'
  return ctx.db.getSetting('auto_reply', fallback) === 'on'
}

export async function handleIncoming(ctx, msg, text, kind) {
  const { wa, db, llm, config, logger, state } = ctx
  const ar = config.autoReply
  const jid = msg.key.remoteJid
  const senderJid = msg.key.participant || jid
  const sender = jidUser(senderJid)
  const now = Date.now()

  // --- gates -----------------------------------------------------------------
  if (!autoReplyEnabled(ctx)) return
  if (ar.allow.length && !ar.allow.includes(sender)) return
  if (ar.block.includes(sender)) return

  if (isGroup(jid)) {
    if (!ar.groups) return
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? []
    if (!mentioned.some((j) => wa.isSelfChat(j))) return // only when @mentioned
  }

  const manual = state.lastManual.get(jid)
  if (manual && now - manual < ar.manualCooldownMin * 60_000) {
    logger.debug({ jid }, 'skip: owner replied manually recently')
    return
  }
  const last = state.lastAuto.get(jid)
  if (last && now - last < ar.minGapSec * 1000) {
    logger.debug({ jid }, 'skip: per-chat gap')
    return
  }
  state.autoTimes = state.autoTimes.filter((t) => now - t < 3_600_000)
  if (state.autoTimes.length >= ar.maxPerHour) {
    logger.warn('skip: hourly auto-reply cap reached')
    return
  }

  // --- build the conversation --------------------------------------------------
  const userText = text || `[sent a ${kind} with no text]`
  const contactName = msg.pushName || db.contactName(senderJid) || sender
  const history = db.history(jid, ar.historyTurns)
  const system = autoReplySystem({
    ownerName: config.ownerName,
    persona: db.getSetting('persona', '') || ar.persona, // /persona overrides .env
    contactName,
    firstTime: history.length === 0,
    now: new Date().toString(),
  })

  // --- reply -------------------------------------------------------------------
  await wa.typing(jid, true)
  let reply
  try {
    reply = await llm.chat({ system, messages: [...history, { role: 'user', content: userText }], maxTokens: 300 })
  } finally {
    await wa.typing(jid, false)
  }
  if (!reply) return

  await wa.sendText(jid, reply)
  db.addMessage(jid, 'user', userText)
  db.addMessage(jid, 'assistant', reply)
  state.lastAuto.set(jid, Date.now())
  state.autoTimes.push(Date.now())
  if (ar.markRead) await wa.markRead([msg.key])
  logger.info({ jid, contactName }, 'auto-replied')
}
