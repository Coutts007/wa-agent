// Decides what to do with each incoming message:
//   status@broadcast           -> capture the status
//   from me, in my own chat    -> owner command or chat with the assistant
//   from me, in another chat   -> I replied manually: pause auto-reply there for a while
//   from someone else          -> auto-reply (subject to filters and rate limits)

import { extractText, isNewsletter, isStatusJid, jidUser, kindOf } from './utils.js'
import { captureStatus } from './handlers/status.js'
import { handleOwnerMessage } from './handlers/ownerChat.js'
import { handleIncoming } from './handlers/autoReply.js'

export function createRouter({ wa, db, llm, config, logger, recentLogs = () => [] }) {
  const state = {
    lastManual: new Map(), // chat jid -> ms when the owner last replied manually
    lastAuto: new Map(), // chat jid -> ms when we last auto-replied
    autoTimes: [], // timestamps of recent auto-replies (global hourly cap)
    startedAt: Date.now(),
  }
  const ctx = { wa, db, llm, config, logger, state, recentLogs }

  async function handleUpsert({ messages, type }) {
    // 'notify' = new messages arriving live. 'append' = history sync and our own sends.
    if (type !== 'notify') return
    for (const msg of messages) {
      try {
        await route(msg)
      } catch (err) {
        logger.error({ err, id: msg?.key?.id, jid: msg?.key?.remoteJid }, 'failed to handle message')
      }
    }
  }

  /** The chat where you talk to the bot: your own chat, or one you pinned with /claim. */
  function isOwnerChat(jid) {
    if (wa.isSelfChat(jid)) return true
    const claimed = db.getSetting('owner_chat_jid', '')
    return Boolean(claimed) && jidUser(claimed) === jidUser(jid)
  }

  async function route(msg) {
    const key = msg.key ?? {}
    const jid = key.remoteJid
    if (!msg.message || !jid) return
    if (key.id && wa.sentIds.has(key.id)) return // echo of something we sent

    const sender = key.participant || jid
    if (msg.pushName && !key.fromMe) db.upsertContact(sender, msg.pushName)

    if (isStatusJid(jid)) {
      if (!key.fromMe && config.status.capture) await captureStatus(ctx, msg)
      logger.info({ from: jidUser(sender), name: msg.pushName }, 'status received')
      return
    }
    if (isNewsletter(jid)) return

    const kind = kindOf(msg.message)
    if (kind === 'system' || kind === 'empty') return
    const text = extractText(msg.message)

    // Escape hatch: typing "/claim" (from your phone, in any chat) makes that chat the
    // owner chat. Useful if WhatsApp identifies your self-chat in a way we don't recognise.
    if (key.fromMe && text.trim().toLowerCase() === `${config.commandPrefix}claim`) {
      db.setSetting('owner_chat_jid', jid)
      logger.info({ jid }, 'owner chat claimed')
      await wa.sendText(jid, `Got it — this chat is now where you talk to me. Send ${config.commandPrefix}help to start.`)
      return
    }

    let route
    if (key.fromMe) {
      if (isOwnerChat(jid)) {
        route = 'owner'
        if (text) await handleOwnerMessage(ctx, msg, text)
      } else {
        route = 'manual-reply'
        state.lastManual.set(jid, Date.now())
      }
    } else {
      route = 'incoming'
      await handleIncoming(ctx, msg, text, kind)
    }
    logger.info({ jid, fromMe: Boolean(key.fromMe), kind, route }, 'message')
  }

  function handleContacts(contacts) {
    for (const c of contacts ?? []) {
      const name = c.name || c.notify || c.verifiedName
      if (c.id && name) db.upsertContact(c.id, name)
    }
  }

  return { handleUpsert, handleContacts, ctx }
}
