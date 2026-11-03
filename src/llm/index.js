// Provider-agnostic LLM facade. Switch providers with LLM_PROVIDER=anthropic|gemini|mock.
//
// Message format used throughout the app:
//   { role: 'user' | 'assistant', content: string | Part[] }
//   Part = { type: 'text', text } | { type: 'image', mimeType, data /* base64 */ }
//
// Provider SDKs are imported lazily so the app (and the smoke test) can run with
// only the provider you actually use installed.

export async function createLLM(cfg, logger) {
  const provider = (cfg.provider || 'anthropic').toLowerCase()
  let impl
  switch (provider) {
    case 'anthropic':
      impl = (await import('./anthropic.js')).create(cfg)
      break
    case 'gemini':
      impl = (await import('./gemini.js')).create(cfg)
      break
    case 'mock':
      impl = (await import('./mock.js')).create(cfg)
      break
    default:
      throw new Error(`Unknown LLM_PROVIDER "${provider}" (use anthropic, gemini or mock)`)
  }

  const fallbackModel = cfg.fallbackModel && cfg.fallbackModel !== impl.model ? cfg.fallbackModel : ''

  async function chat({ system, messages, maxTokens = 600 }) {
    const normalised = normalise(messages)
    if (!normalised.length) return ''
    const t0 = Date.now()
    const call = (model) =>
      withRetry(() => impl.chat({ system, messages: normalised, maxTokens, model }), { logger })
    let model = impl.model
    let out
    try {
      out = await call(model)
    } catch (err) {
      if (!fallbackModel || !isOverloadedError(err)) throw err
      logger?.warn({ model, fallback: fallbackModel, status: statusOf(err) }, 'model unavailable, switching to fallback')
      model = fallbackModel
      out = await call(model)
    }
    logger?.debug({ provider, model, ms: Date.now() - t0 }, 'llm call')
    return (out || '').trim()
  }

  async function describeImage({ mimeType, data, prompt }) {
    return chat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mimeType, data },
            { type: 'text', text: prompt },
          ],
        },
      ],
      maxTokens: 300,
    })
  }

  return { provider, model: impl.model, fallbackModel, chat, describeImage }
}

const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 529])
const OVERLOADED_STATUS = new Set([429, 500, 502, 503, 504, 529]) // another model may answer; a network error won't care

const statusOf = (err) => Number(err?.status ?? err?.statusCode ?? err?.response?.status)

/** The provider answered but could not serve this model right now (capacity, rate limit, 5xx). */
export function isOverloadedError(err) {
  return OVERLOADED_STATUS.has(statusOf(err))
}

/** Network blips and overloaded-server responses are worth one more try; auth/4xx errors are not. */
export function isTransientError(err) {
  if (!err) return false
  if (TRANSIENT_STATUS.has(statusOf(err))) return true
  const codes = [err.code, err.cause?.code, ...(err.cause?.errors ?? err.errors ?? []).map((e) => e?.code)]
  if (codes.some((c) => TRANSIENT_CODES.has(c))) return true
  return /fetch failed|network|socket hang up|timed? ?out/i.test(String(err.message || ''))
}

/**
 * Runs fn, retrying on transient errors with a short backoff. One lost call means a contact
 * never gets a reply (the message is not seen again), so a couple of retries matter here.
 */
export async function withRetry(fn, { retries = 2, baseDelayMs = 1000, logger } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= retries || !isTransientError(err)) throw err
      const delay = baseDelayMs * 2 ** attempt
      logger?.warn({ err: err?.cause?.message || err?.message, attempt: attempt + 1, delay }, 'llm call failed, retrying')
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

/**
 * Providers want a conversation that starts with a user turn and alternates roles.
 * Merge consecutive same-role turns and drop a leading assistant turn.
 */
export function normalise(messages) {
  const out = []
  for (const m of messages) {
    if (!m || !m.content || (typeof m.content === 'string' && !m.content.trim())) continue
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content = mergeContent(last.content, m.content)
    } else {
      out.push({ role, content: m.content })
    }
  }
  while (out.length && out[0].role === 'assistant') out.shift()
  return out
}

function mergeContent(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`
  const parts = (x) => (typeof x === 'string' ? [{ type: 'text', text: x }] : x)
  return [...parts(a), ...parts(b)]
}
