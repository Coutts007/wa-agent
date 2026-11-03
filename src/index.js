import net from 'node:net'
import { Writable } from 'node:stream'
import pino from 'pino'
import { config } from './config.js'
import { openDb } from './db.js'
import { createLLM } from './llm/index.js'
import { createWhatsApp } from './whatsapp.js'
import { createRouter } from './router.js'

// Keep the last few hundred warn/error lines in memory so `/logs` can show them from WhatsApp.
const recentLogs = []
const ringBuffer = new Writable({
  write(chunk, _enc, cb) {
    for (const line of chunk.toString().split('\n')) {
      if (!line) continue
      recentLogs.push(line)
      if (recentLogs.length > 300) recentLogs.shift()
    }
    cb()
  },
})
const logger = pino(
  { level: config.logLevel },
  pino.multistream([
    { level: config.logLevel, stream: process.stdout },
    { level: 'warn', stream: ringBuffer },
  ]),
)
const baileysLogger = logger.child({ module: 'baileys' }, { level: config.baileysLogLevel })

// Node gives each resolved address only 250 ms to complete a TCP handshake before trying the
// next one ("happy eyeballs"). The LLM endpoints resolve to many IPv6 addresses that boxes
// without IPv6 cannot reach, leaving one IPv4 address with a 250 ms budget — on a slow link
// that fails with "fetch failed / AggregateError ETIMEDOUT". Give each attempt a real budget.
net.setDefaultAutoSelectFamilyAttemptTimeout(10_000)

// libsignal (used by Baileys) prints key-sync chatter and whole session objects straight to
// the console, bypassing the logger. Drop those lines unless LOG_LEVEL=debug.
if (config.logLevel !== 'debug' && config.logLevel !== 'trace') {
  const NOISE = [
    /^Session error:/,
    /^Closing session:/,
    /^Closing open session/,
    /^Failed to decrypt message with any known session/,
    /^Decrypted message with closed session/,
  ]
  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method].bind(console)
    console[method] = (...args) => {
      if (typeof args[0] === 'string' && NOISE.some((re) => re.test(args[0]))) return
      original(...args)
    }
  }
}

async function main() {
  const db = await openDb(config.dbPath)
  const llm = await createLLM(config.llm, logger)
  logger.info(
    { provider: llm.provider, model: llm.model, db: config.dbPath, sqlite: db.driver, node: process.version },
    'starting wa-agent',
  )

  const wa = createWhatsApp({ config, logger: baileysLogger })
  const router = createRouter({ wa, db, llm, config, logger, recentLogs: () => recentLogs.slice() })
  await wa.connect({ onUpsert: router.handleUpsert, onContacts: router.handleContacts })

  // Housekeeping: drop expired statuses and month-old chat history once an hour.
  setInterval(() => {
    const s = db.pruneStatuses()
    const m = db.pruneMessages(30 * 24 * 60 * 60 * 1000)
    if (s || m) logger.info({ statuses: s, messages: m }, 'pruned')
  }, 60 * 60 * 1000).unref()

  const shutdown = () => {
    logger.info('shutting down')
    try {
      db.close()
    } catch {}
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal')
  process.exit(1)
})
