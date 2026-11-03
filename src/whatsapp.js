// WhatsApp connection via Baileys (unofficial WhatsApp Web multi-device library).
// This module is the only place that imports Baileys; everything else talks to the
// small `wa` object it returns, which makes the rest of the app testable offline.

import * as Baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import { jidUser, sleep } from './utils.js'

// Baileys 6.7.24+ is an ES module: named exports, and `default` is makeWASocket itself.
// Older builds were CommonJS, where `default` is the whole exports object. Resolve both.
const lib =
  Baileys.default && typeof Baileys.default === 'object' ? { ...Baileys.default, ...Baileys } : Baileys
const makeWASocket =
  lib.makeWASocket ?? (typeof Baileys.default === 'function' ? Baileys.default : Baileys.default?.default)
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  downloadMediaMessage,
} = lib

for (const [name, fn] of Object.entries({
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
})) {
  if (typeof fn !== 'function') {
    throw new Error(`Baileys export "${name}" not found — unsupported @whiskeysockets/baileys version?`)
  }
}

/**
 * Creates the `wa` facade immediately (so other modules can hold a reference) and
 * connects when `wa.connect({ onUpsert, onContacts })` is awaited.
 */
export function createWhatsApp({ config, logger }) {
  const wa = {
    sock: null,
    ready: false,
    sentIds: new Set(), // ids of messages this bot sent, so echoes are ignored
    selfJids: new Set(), // user parts of our own jid(s): phone number and LID
  }
  let attempts = 0
  let onUpsert = async () => {}
  let onContacts = null

  // Our own identifiers: phone-number JID, LID (WhatsApp's anonymous id, which is what the
  // "Message yourself" chat uses), and OWNER_NUMBER from .env. Computed on every call because
  // the LID can arrive a moment after the connection opens.
  function selfIds() {
    const me = wa.sock?.user ?? {}
    return [me.id, me.lid, config.ownerNumber].filter(Boolean).map(jidUser)
  }

  async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
    let version
    try {
      ;({ version } = await fetchLatestBaileysVersion())
    } catch {
      version = undefined // fall back to the library's bundled version
    }

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: ['WA-Agent', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false, // keeps your phone receiving notifications
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    })
    wa.sock = sock

    sock.ev.on('creds.update', saveCreds)

    // Pairing-code flow (no QR): set PAIRING_NUMBER in .env. Request it once the socket is up.
    if (!state.creds.registered && config.pairingNumber) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(config.pairingNumber)
          console.log(
            `\nPairing code: ${code}\nOn your phone: WhatsApp > Linked devices > Link a device > Link with phone number instead.\n`,
          )
        } catch (err) {
          logger.error({ err }, 'could not request pairing code')
        }
      }, 3000)
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr && !config.pairingNumber) {
        console.log('\nScan this QR with WhatsApp > Linked devices > Link a device:\n')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        attempts = 0
        wa.ready = true
        wa.selfJids = new Set(selfIds())
        const me = sock.user ?? {}
        console.log(
          `Connected to WhatsApp as ${me.name || 'unknown'} · number ${jidUser(me.id || '')} · lid ${jidUser(me.lid || '') || '(not yet known)'}`,
        )
      }

      if (connection === 'close') {
        wa.ready = false
        const code = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode
        if (code === DisconnectReason.loggedOut) {
          console.error('\nWhatsApp logged this device out. Run `npm run reset-auth` and link again.\n')
          process.exit(1)
        }
        attempts += 1
        const delay = Math.min(30_000, 2_000 * attempts)
        logger.warn({ code }, `connection closed, reconnecting in ${delay} ms`)
        await sleep(delay)
        start().catch((err) => logger.error({ err }, 'reconnect failed'))
      }
    })

    sock.ev.on('messages.upsert', (ev) => {
      onUpsert(ev).catch((err) => logger.error({ err }, 'message handler failed'))
    })

    if (onContacts) {
      sock.ev.on('contacts.upsert', onContacts)
      sock.ev.on('contacts.update', onContacts)
    }

    return sock
  }

  wa.isSelfChat = (jid) => {
    const u = jidUser(jid)
    return Boolean(u) && selfIds().includes(u)
  }

  wa.sendText = async (jid, text) => {
    const res = await wa.sock.sendMessage(jid, { text })
    if (res?.key?.id) {
      wa.sentIds.add(res.key.id)
      if (wa.sentIds.size > 5000) wa.sentIds.clear()
    }
    return res
  }

  wa.typing = (jid, on = true) =>
    wa.sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid).catch(() => {})

  wa.markRead = (keys) => wa.sock.readMessages(keys).catch(() => {})

  wa.downloadMedia = (msg) =>
    downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: wa.sock.updateMediaMessage })

  wa.connect = async (handlers = {}) => {
    if (handlers.onUpsert) onUpsert = handlers.onUpsert
    if (handlers.onContacts) onContacts = handlers.onContacts
    await start()
    return wa
  }

  return wa
}
