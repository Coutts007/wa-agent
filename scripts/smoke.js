// Offline smoke test: runs the router + handlers against a fake WhatsApp socket and the
// mock LLM. No network, no API keys, no WhatsApp. `npm run smoke`
import assert from 'node:assert/strict'

process.env.LLM_PROVIDER = 'mock'
process.env.DB_PATH = ':memory:'
process.env.OWNER_NAME = 'Tester'
process.env.OWNER_NUMBER = '254700000001'
process.env.AUTO_REPLY_MIN_GAP_SEC = '5'

const { config } = await import('../src/config.js')
const { openDb } = await import('../src/db.js')
const { createLLM } = await import('../src/llm/index.js')
const { createRouter } = await import('../src/router.js')
const { jidUser } = await import('../src/utils.js')
const { withRetry, isTransientError } = await import('../src/llm/index.js')

const SELF = '254700000001@s.whatsapp.net'
const JANE = '254711111111@s.whatsapp.net'
const KEVIN = '254722222222@s.whatsapp.net'
const MARY = '254733333333@s.whatsapp.net'

const sent = []
const wa = {
  ready: true,
  sentIds: new Set(),
  selfJids: new Set(['254700000001']),
  isSelfChat: (jid) => wa.selfJids.has(jidUser(jid)),
  async sendText(jid, text) {
    sent.push({ jid, text })
    const id = `BOT${sent.length}`
    wa.sentIds.add(id)
    return { key: { id, remoteJid: jid, fromMe: true } }
  },
  typing: async () => {},
  markRead: async () => {},
  downloadMedia: async () => Buffer.from('fake-jpeg-bytes'),
}

const quiet = { info() {}, warn() {}, error(e) { console.error(e) }, debug() {}, child() { return quiet } }
const db = await openDb(config.dbPath)
console.log(`Node ${process.version}, sqlite driver: ${db.driver}`)
const llm = await createLLM(config.llm, quiet)
const fakeLogs = [
  JSON.stringify({ level: 40, time: Date.now() - 60000, module: 'baileys', msg: 'connection closed, reconnecting in 2000 ms' }),
  JSON.stringify({ level: 50, time: Date.now(), msg: 'failed to handle message', err: { message: '401 authentication_error' } }),
]
const router = createRouter({ wa, db, llm, config, logger: quiet, recentLogs: () => fakeLogs })

let n = 0
const ts = () => Math.floor(Date.now() / 1000)
const incoming = (jid, text, extra = {}) => ({
  key: { remoteJid: jid, fromMe: false, id: `M${++n}` },
  pushName: extra.pushName ?? 'Someone',
  message: { conversation: text },
  messageTimestamp: ts(),
})
const owner = (text) => ({
  key: { remoteJid: SELF, fromMe: true, id: `O${++n}` },
  message: { conversation: text },
  messageTimestamp: ts(),
})
const status = (poster, name, message) => ({
  key: { remoteJid: 'status@broadcast', participant: poster, fromMe: false, id: `S${++n}` },
  pushName: name,
  message,
  messageTimestamp: ts(),
})
const push = (msgs, type = 'notify') => router.handleUpsert({ messages: Array.isArray(msgs) ? msgs : [msgs], type })
const lastSent = () => sent[sent.length - 1]

// 1. Stranger writes -> auto-reply goes to that chat
await push(incoming(JANE, 'Hi, are you around?', { pushName: 'Jane' }))
assert.equal(sent.length, 1, 'one auto-reply expected')
assert.equal(lastSent().jid, JANE)
assert.match(lastSent().text, /mock reply/)
assert.equal(db.history(JANE).length, 2, 'both turns stored')

// 2. Same chat again immediately -> suppressed by per-chat gap
await push(incoming(JANE, 'hello??', { pushName: 'Jane' }))
assert.equal(sent.length, 1, 'second message within the gap must not get a reply')

// 3. History-sync / own sends (type=append) are ignored
await push(incoming(MARY, 'from history'), 'append')
assert.equal(sent.length, 1)

// 4. Echo of our own sent message is ignored
await push({ key: { remoteJid: JANE, fromMe: true, id: 'BOT1' }, message: { conversation: 'echo' } })
assert.equal(sent.length, 1)

// 5. Statuses are captured: text, image (with vision description), video (thumbnail)
await push(status(KEVIN, 'Kevin', { extendedTextMessage: { text: 'Arsenal tonight!! Who is watching?' } }))
await push(status(MARY, 'Mary', { imageMessage: { caption: 'New stock in, DM for prices', mimetype: 'image/jpeg' } }))
await push(status(MARY, 'Mary', { videoMessage: { caption: 'Sunday vibes', jpegThumbnail: new Uint8Array([1, 2, 3]) } }))
await push(status(KEVIN, 'Kevin', { protocolMessage: { type: 0 } })) // a revoke: must be ignored
const rows = db.activeStatuses()
assert.equal(rows.length, 3, 'three statuses stored')
const img = rows.find((r) => r.kind === 'image')
assert.match(img.description, /mock description/, 'image status got a vision description')
assert.equal(rows.find((r) => r.kind === 'video').poster_name, 'Mary')
assert.equal(sent.length, 1, 'capturing statuses must not send anything')

// 6. Owner commands in the self chat
await push(owner('/statuses'))
assert.match(lastSent().text, /Arsenal tonight/)
assert.match(lastSent().text, /New stock in/)

await push(owner('/recommend football banter'))
assert.match(lastSent().text, /^1\. /m, 'recommendation is a numbered list')

await push(owner('any funny statuses worth watching?'))
assert.match(lastSent().text, /^1\. /m, 'natural-language status request routes to recommend')

await push(owner('/status'))
assert.match(lastSent().text, /Auto-reply: on/)
assert.match(lastSent().text, /Statuses stored \(24h\): 3/)

// 7. Pause / resume gates auto-reply
await push(owner('/pause'))
await push(incoming(MARY, 'Hey!', { pushName: 'Mary' }))
assert.ok(!sent.some((s) => s.jid === MARY), 'no auto-reply while paused')
await push(owner('/resume'))
await push(incoming(MARY, 'Hey again!', { pushName: 'Mary' }))
assert.ok(sent.some((s) => s.jid === MARY), 'auto-reply resumes')

// 8. Owner replying manually from the phone pauses auto-reply in that chat
const BOB = '254744444444@s.whatsapp.net'
await push({ key: { remoteJid: BOB, fromMe: true, id: 'P1' }, message: { conversation: 'on my way' } })
await push(incoming(BOB, 'ok see you', { pushName: 'Bob' }))
assert.ok(!sent.some((s) => s.jid === BOB), 'manual-reply cooldown respected')

// 9. Plain chat with the owner keeps history; /clear wipes it
const before = sent.length
await push(owner('remind me what I asked you earlier'))
assert.equal(sent.length, before + 1)
assert.ok(db.history('owner').length >= 2)
await push(owner('/clear'))
assert.equal(db.history('owner').length, 0)

// 10. LID self-chat not recognised -> /claim pins it, then commands work there
const LID_SELF = '70382115635264@lid'
await push({ key: { remoteJid: LID_SELF, fromMe: true, id: 'L1' }, message: { conversation: '/help' } })
assert.ok(!sent.some((s) => s.jid === LID_SELF), 'unknown LID chat is not treated as owner chat yet')
await push({ key: { remoteJid: LID_SELF, fromMe: true, id: 'L2' }, message: { conversation: '/claim' } })
assert.match(lastSent().text, /this chat is now/)
await push({ key: { remoteJid: LID_SELF, fromMe: true, id: 'L3' }, message: { conversation: '/help' } })
assert.equal(lastSent().jid, LID_SELF)
assert.match(lastSent().text, /\/statuses – captured/, 'commands work in the claimed chat')

// 11. Ops commands: /logs, /persona, /status reflects persona
await push(owner('/logs'))
assert.match(lastSent().text, /Last 2 warnings\/errors/)
assert.match(lastSent().text, /ERR: failed to handle message — 401/)
await push(owner('/persona Travelling until Friday, slow to reply. For anything urgent, call.'))
assert.match(lastSent().text, /Persona updated/)
assert.equal(db.getSetting('persona'), 'Travelling until Friday, slow to reply. For anything urgent, call.')
await push(owner('/persona'))
assert.match(lastSent().text, /Travelling until Friday/)
await push(owner('/status'))
assert.match(lastSent().text, /persona: custom/)
await push(owner('/persona clear'))
assert.equal(db.getSetting('persona', ''), '')

// 12. Groups: ignored unless enabled and @mentioned
const GROUP = '120363000000000000@g.us'
await push({
  key: { remoteJid: GROUP, participant: JANE, fromMe: false, id: 'G1' },
  pushName: 'Jane',
  message: { extendedTextMessage: { text: '@me where are you', contextInfo: { mentionedJid: [SELF] } } },
})
assert.ok(!sent.some((s) => s.jid === GROUP), 'groups off by default')

// 13. LLM calls retry on network blips (the "fetch failed / ETIMEDOUT" case) but not on auth errors
{
  const netErr = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new AggregateError([Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]), { code: 'ETIMEDOUT' }),
  })
  let calls = 0
  const out = await withRetry(async () => { if (++calls < 3) throw netErr; return 'ok' }, { baseDelayMs: 1 })
  assert.equal(out, 'ok')
  assert.equal(calls, 3, 'two retries then success')
  await assert.rejects(() => withRetry(async () => { throw netErr }, { baseDelayMs: 1 }), /fetch failed/, 'gives up after retries')
  const authErr = Object.assign(new Error('401 authentication_error'), { status: 401 })
  calls = 0
  await assert.rejects(() => withRetry(async () => { calls++; throw authErr }, { baseDelayMs: 1 }), /401/)
  assert.equal(calls, 1, 'auth errors are not retried')
  assert.ok(isTransientError({ status: 529 }), 'overloaded is transient')
  assert.ok(!isTransientError({ status: 400 }), 'bad request is not')
}

// 14. An overloaded main model falls back to LLM_FALLBACK_MODEL; without one the error surfaces
{
  const warned = []
  const log = { ...quiet, warn: (o) => warned.push(o) }
  const primaryDown = await createLLM({ provider: 'mock', model: 'mock-overloaded', fallbackModel: 'mock' }, log)
  const out = await primaryDown.chat({ messages: [{ role: 'user', content: 'hello' }] })
  assert.match(out, /mock reply/, 'fallback model answered')
  assert.ok(warned.some((w) => w.fallback === 'mock'), 'switch to fallback is logged')
  const noFallback = await createLLM({ provider: 'mock', model: 'mock-overloaded' }, quiet)
  await assert.rejects(() => noFallback.chat({ messages: [{ role: 'user', content: 'hello' }] }), /503/)
}

console.log(`\nAll smoke checks passed. ${sent.length} messages "sent", ${db.countActiveStatuses()} statuses stored.`)
db.close()
