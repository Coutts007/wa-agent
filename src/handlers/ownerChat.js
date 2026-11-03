// Handles messages you send to yourself (WhatsApp's "Message yourself" chat):
// slash commands, natural-language status requests, and plain chat with the assistant.

import { ownerSystem } from '../prompts.js'
import { autoReplyEnabled } from './autoReply.js'
import { listStatuses, recommendStatuses } from './status.js'

export const OWNER_CHAT = 'owner'

const help = (p) =>
  [
    'Statuses',
    `${p}statuses – captured in the last 24h`,
    `${p}recommend <what you feel like> – pick ones worth watching`,
    '',
    'Auto-reply',
    `${p}pause / ${p}resume – stop or start replying to people`,
    `${p}persona <text> – change what I may say about you (${p}persona to view, ${p}persona clear to reset)`,
    '',
    'Operations',
    `${p}status – health, counts, settings`,
    `${p}logs – recent warnings/errors`,
    `${p}restart – restart the bot (needs pm2/systemd/Docker to bring it back)`,
    `${p}clear – forget our chat history`,
    `${p}claim – make this chat the one I answer you in`,
    `${p}help – this list`,
    '',
    'Or just talk to me, e.g. "any funny statuses worth watching?"',
  ].join('\n')

const WANTS_STATUSES = /\b(status|statuses|stories|story)\b/i
const WANTS_PICKS = /\b(watch|recommend|suggest|worth|should i|anything|interesting|good ones|best)\b/i

export async function handleOwnerMessage(ctx, msg, text) {
  const { wa, db, llm, config } = ctx
  const jid = msg.key.remoteJid
  const say = (t) => wa.sendText(jid, t)
  const p = config.commandPrefix

  if (text.startsWith(p)) {
    const [cmd = '', ...rest] = text.slice(p.length).trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (cmd.toLowerCase()) {
      case 'help':
        return say(help(p))
      case 'pause':
        db.setSetting('auto_reply', 'off')
        return say(`Auto-reply paused. Send ${p}resume to turn it back on.`)
      case 'resume':
        db.setSetting('auto_reply', 'on')
        return say('Auto-reply is on.')
      case 'statuses':
      case 'stories':
        return say(listStatuses(ctx))
      case 'recommend':
      case 'watch':
      case 'suggest':
        return say(await recommendStatuses(ctx, arg || 'anything interesting'))
      case 'persona':
        return say(persona(ctx, arg))
      case 'status':
      case 'info':
        return say(botStatus(ctx))
      case 'logs':
        return say(recentLogs(ctx, Number(arg) || 12))
      case 'restart':
        await say('Restarting now. Back in a few seconds if a process manager is running me.')
        ctx.logger.warn('restart requested from owner chat')
        setTimeout(() => process.exit(0), 1500)
        return
      case 'clear':
        db.clearHistory(OWNER_CHAT)
        return say('Chat history cleared.')
      default:
        return say(`Unknown command ${p}${cmd}. Send ${p}help for the list.`)
    }
  }

  // "which statuses should I watch about football?" without a slash command
  if (WANTS_STATUSES.test(text) && WANTS_PICKS.test(text)) {
    return say(await recommendStatuses(ctx, text))
  }

  const history = db.history(OWNER_CHAT, config.autoReply.historyTurns)
  const reply = await llm.chat({
    system: ownerSystem({
      ownerName: config.ownerName,
      statusCount: db.countActiveStatuses(),
      now: new Date().toString(),
    }),
    messages: [...history, { role: 'user', content: text }],
    maxTokens: 600,
  })
  db.addMessage(OWNER_CHAT, 'user', text)
  db.addMessage(OWNER_CHAT, 'assistant', reply)
  return say(reply || "I didn't get a reply from the model; try again.")
}

function persona(ctx, arg) {
  const { db, config } = ctx
  if (!arg) {
    const current = db.getSetting('persona', '') || config.autoReply.persona
    return current ? `Current persona:\n${current}` : 'No persona set. Send /persona <text> to add one.'
  }
  if (arg.toLowerCase() === 'clear') {
    db.setSetting('persona', '')
    return config.autoReply.persona
      ? `Custom persona cleared; back to the one in .env:\n${config.autoReply.persona}`
      : 'Persona cleared.'
  }
  db.setSetting('persona', arg)
  return `Persona updated. Auto-replies will now use:\n${arg}`
}

function recentLogs(ctx, n) {
  const lines = ctx.recentLogs().slice(-Math.min(n, 40))
  if (!lines.length) return 'No warnings or errors since the last start.'
  const out = lines.map((line) => {
    try {
      const j = JSON.parse(line)
      const t = new Date(j.time).toLocaleTimeString('en-GB', { hour12: false })
      const lvl = j.level >= 50 ? 'ERR' : 'WARN'
      const extra = j.err?.message || j.error?.message || (typeof j.err === 'string' ? j.err : '')
      return `${t} ${lvl}${j.module ? ' ' + j.module : ''}: ${j.msg}${extra ? ' — ' + String(extra).slice(0, 120) : ''}`
    } catch {
      return line.slice(0, 160)
    }
  })
  return `Last ${out.length} warnings/errors:\n${out.join('\n')}`
}

function botStatus(ctx) {
  const { wa, db, llm, config, state } = ctx
  const upMin = Math.round((Date.now() - state.startedAt) / 60_000)
  const customPersona = Boolean(db.getSetting('persona', ''))
  return [
    `Connection: ${wa.ready ? 'connected' : 'reconnecting'} · up ${upMin} min · host ${process.env.HOSTNAME || 'unknown'}`,
    `Auto-reply: ${autoReplyEnabled(ctx) ? 'on' : 'off'}${config.autoReply.groups ? ' (groups when @mentioned)' : ''} · persona: ${customPersona ? 'custom' : config.autoReply.persona ? '.env' : 'none'}`,
    `Statuses stored (24h): ${db.countActiveStatuses()} · capture ${config.status.capture ? 'on' : 'off'} · describe media ${config.status.describeMedia ? 'on' : 'off'}`,
    `Model: ${llm.provider}/${llm.model} · Node ${process.version}`,
  ].join('\n')
}
