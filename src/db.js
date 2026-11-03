// SQLite persistence. Uses Node's built-in node:sqlite on Node 22.13+ (no native build),
// and falls back to the better-sqlite3 package on older Node (20.x). Both expose the same
// prepare/run/get/all API, so the rest of this file doesn't care which one loaded.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

async function loadDriver() {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return { name: 'node:sqlite', open: (p) => new DatabaseSync(p) }
  } catch {
    try {
      const { default: Database } = await import('better-sqlite3')
      return { name: 'better-sqlite3', open: (p) => new Database(p) }
    } catch (err) {
      throw new Error(
        `No SQLite driver available. Either run on Node 22.13+ (built-in node:sqlite) ` +
          `or install the fallback: npm install better-sqlite3\n(${err.message})`,
      )
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS statuses (
  id          TEXT PRIMARY KEY,          -- WhatsApp message id
  poster_jid  TEXT NOT NULL,
  poster_name TEXT,
  kind        TEXT NOT NULL,             -- text | image | video | audio | other
  caption     TEXT,                      -- text status body or media caption
  description TEXT,                      -- vision-model description of the media
  posted_at   INTEGER NOT NULL,          -- ms epoch
  expires_at  INTEGER NOT NULL,          -- posted_at + 24h
  viewed      INTEGER NOT NULL DEFAULT 0,
  raw_key     TEXT                       -- JSON of the message key (for marking viewed)
);
CREATE INDEX IF NOT EXISTS idx_statuses_expires ON statuses(expires_at);

CREATE TABLE IF NOT EXISTS messages (   -- conversation history, one row per turn
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat    TEXT NOT NULL,                 -- chat jid, or "owner" for your own chat with the bot
  role    TEXT NOT NULL,                 -- user | assistant
  content TEXT NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat, ts);

CREATE TABLE IF NOT EXISTS contacts (
  jid        TEXT PRIMARY KEY,
  name       TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

export async function openDb(path) {
  const driver = await loadDriver()
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = driver.open(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)

  const q = {
    insStatus: db.prepare(
      `INSERT OR IGNORE INTO statuses
         (id, poster_jid, poster_name, kind, caption, description, posted_at, expires_at, raw_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    activeStatuses: db.prepare(
      `SELECT * FROM statuses WHERE expires_at > ? ORDER BY posted_at DESC LIMIT ?`,
    ),
    countActive: db.prepare(`SELECT COUNT(*) AS n FROM statuses WHERE expires_at > ?`),
    markViewed: db.prepare(`UPDATE statuses SET viewed = 1 WHERE id = ?`),
    pruneStatuses: db.prepare(`DELETE FROM statuses WHERE expires_at < ?`),

    insMsg: db.prepare(`INSERT INTO messages (chat, role, content, ts) VALUES (?, ?, ?, ?)`),
    history: db.prepare(
      `SELECT role, content FROM (
         SELECT id, role, content FROM messages WHERE chat = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    ),
    clearHistory: db.prepare(`DELETE FROM messages WHERE chat = ?`),
    pruneMessages: db.prepare(`DELETE FROM messages WHERE ts < ?`),

    upsertContact: db.prepare(
      `INSERT INTO contacts (jid, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ),
    contactName: db.prepare(`SELECT name FROM contacts WHERE jid = ?`),

    setSetting: db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  }

  return {
    raw: db,
    driver: driver.name,

    /** Returns true if the status was new (not already stored). */
    saveStatus(s) {
      const r = q.insStatus.run(
        s.id,
        s.posterJid,
        s.posterName ?? null,
        s.kind,
        s.caption || null,
        s.description || null,
        s.postedAt,
        s.expiresAt,
        s.rawKey ? JSON.stringify(s.rawKey) : null,
      )
      return r.changes > 0
    },
    activeStatuses(limit = 100) {
      return q.activeStatuses.all(Date.now(), limit)
    },
    countActiveStatuses() {
      return q.countActive.get(Date.now())?.n ?? 0
    },
    markStatusViewed(id) {
      q.markViewed.run(id)
    },
    pruneStatuses() {
      return q.pruneStatuses.run(Date.now()).changes
    },

    addMessage(chat, role, content) {
      q.insMsg.run(chat, role, content, Date.now())
    },
    history(chat, limit = 12) {
      return q.history.all(chat, limit)
    },
    clearHistory(chat) {
      q.clearHistory.run(chat)
    },
    pruneMessages(olderThanMs) {
      return q.pruneMessages.run(Date.now() - olderThanMs).changes
    },

    upsertContact(jid, name) {
      if (jid && name) q.upsertContact.run(jid, name, Date.now())
    },
    contactName(jid) {
      return q.contactName.get(jid)?.name ?? null
    },

    setSetting(key, value) {
      q.setSetting.run(key, String(value))
    },
    getSetting(key, fallback = null) {
      return q.getSetting.get(key)?.value ?? fallback
    },

    close() {
      db.close()
    },
  }
}
