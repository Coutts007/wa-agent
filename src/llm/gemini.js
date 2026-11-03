// Google Gemini adapter. Requires: npm i @google/genai ; env GEMINI_API_KEY (or LLM_API_KEY).
// Models (Nov 2026): gemini-3.8-flash (default) · gemini-3.5-flash-lite (cheapest).
// Check https://ai.google.dev/models for current names and override with LLM_MODEL.

export function create(cfg) {
  const model = cfg.model || 'gemini-3.8-flash'
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
    async chat({ system, messages, maxTokens }) {
      const ai = await getClient()
      const res = await ai.models.generateContent({
        model,
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: toParts(m.content),
        })),
        config: {
          ...(system ? { systemInstruction: system } : {}),
          maxOutputTokens: maxTokens,
        },
      })
      return res.text ?? ''
    },
  }
}
