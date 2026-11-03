// Google Gemini adapter. Requires: npm i @google/genai ; env GEMINI_API_KEY (or LLM_API_KEY).
// Models (Nov 2026): gemini-3.8-flash (default) · gemini-3.5-flash-lite (cheapest).
// Check https://ai.google.dev/models for current names and override with LLM_MODEL.

export function create(cfg) {
  const model = cfg.model || 'gemini-3.8-flash'
  // Gemini 2.5+/3.x "think" before replying and the thoughts are billed against maxOutputTokens,
  // which truncates short replies. Off by default; LLM_THINKING_BUDGET=-1 restores the model's default.
  const thinkingBudget = Number.isFinite(cfg.thinkingBudget) ? cfg.thinkingBudget : 0
  // Lite models don't think and answer 400 INVALID_ARGUMENT if thinkingConfig is sent at all.
  // Learn that per model on the first 400 instead of hard-coding model names.
  const rejectsThinkingConfig = new Set()
  let client

  async function getClient() {
    if (!client) {
      const { GoogleGenAI } = await import('@google/genai')
      client = new GoogleGenAI({ apiKey: cfg.apiKey || process.env.GEMINI_API_KEY })
    }
    return client
  }

  const toParts = (content) =>
    typeof content === 'string'
      ? [{ text: content }]
      : content.map((p) =>
          p.type === 'image' ? { inlineData: { mimeType: p.mimeType, data: p.data } } : { text: p.text },
        )

  return {
    model,
    async chat({ system, messages, maxTokens, model: override }) {
      const ai = await getClient()
      const m = override || model
      const call = (withThinking) =>
        ai.models.generateContent({
          model: m,
          contents: messages.map((msg) => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: toParts(msg.content),
          })),
          config: {
            ...(system ? { systemInstruction: system } : {}),
            maxOutputTokens: maxTokens,
            ...(withThinking ? { thinkingConfig: { thinkingBudget } } : {}),
          },
        })
      const withThinking = thinkingBudget >= 0 && !rejectsThinkingConfig.has(m)
      let res
      try {
        res = await call(withThinking)
      } catch (err) {
        if (!withThinking || err?.status !== 400) throw err
        res = await call(false) // if this also fails, the 400 had another cause and propagates
        rejectsThinkingConfig.add(m)
      }
      return res.text ?? ''
    },
  }
}
