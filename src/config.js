// Loads .env (if present) and exposes a typed config object.
// Node 22+ has process.loadEnvFile built in, so no dotenv dependency is needed.
try {
  process.loadEnvFile('.env')
} catch {
  // no .env file — fine, rely on real environment variables
}

const env = (key, fallback = '') => process.env[key] ?? fallback
const bool = (key, fallback = false) => {
  const v = process.env[key]
  if (v == null || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}
const num = (key, fallback) => {
  const v = Number(process.env[key])
  return Number.isFinite(v) ? v : fallback
}
const list = (key) =>
  env(key)
    .split(',')
    .map((s) => s.trim().replace(/\D/g, ''))
    .filter(Boolean)

export const config = {
  llm: {
    provider: env('LLM_PROVIDER', 'anthropic'), // anthropic | gemini | mock
    model: env('LLM_MODEL', ''), // empty = provider default
    fallbackModel: env('LLM_FALLBACK_MODEL', ''), // used when the main model is overloaded (503/529/429)
    apiKey: env('LLM_API_KEY', ''), // falls back to ANTHROPIC_API_KEY / GEMINI_API_KEY
  },

  ownerName: env('OWNER_NAME', 'the owner'),
  // Your phone number, digits only (e.g. 254712345678). Optional; used as a fallback
  // when WhatsApp reports your self-chat under a different identifier (LID).
  ownerNumber: env('OWNER_NUMBER').replace(/\D/g, ''),
  // Set this to pair with a code instead of scanning a QR (digits only).
  pairingNumber: env('PAIRING_NUMBER').replace(/\D/g, ''),

  autoReply: {
    enabled: bool('AUTO_REPLY_ENABLED', true),
    groups: bool('AUTO_REPLY_GROUPS', false), // reply in groups only when @mentioned
    allow: list('AUTO_REPLY_ALLOW'), // if non-empty, only these numbers get replies
    block: list('AUTO_REPLY_BLOCK'), // these numbers never get replies
    manualCooldownMin: num('MANUAL_REPLY_COOLDOWN_MIN', 30), // pause after you reply from your phone
    minGapSec: num('AUTO_REPLY_MIN_GAP_SEC', 20), // per-chat minimum gap between auto-replies
    maxPerHour: num('AUTO_REPLY_MAX_PER_HOUR', 60), // global cap
    historyTurns: num('HISTORY_TURNS', 12),
    markRead: bool('AUTO_REPLY_MARK_READ', true),
    persona: env('PERSONA', ''), // free text about you that the assistant may use
  },

  status: {
    capture: bool('STATUS_CAPTURE', true),
    describeMedia: bool('STATUS_DESCRIBE_MEDIA', true), // costs one vision call per image/video status
    autoView: bool('STATUS_AUTO_VIEW', false), // mark statuses as viewed (poster sees you viewed)
  },

  commandPrefix: env('COMMAND_PREFIX', '/'),
  dbPath: env('DB_PATH', './data/wa-agent.db'),
  authDir: env('AUTH_DIR', './auth'),
  logLevel: env('LOG_LEVEL', 'info'),
  baileysLogLevel: env('BAILEYS_LOG_LEVEL', 'warn'),
}
