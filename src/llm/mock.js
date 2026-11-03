// Offline mock provider for tests and dry runs (LLM_PROVIDER=mock). Costs nothing, calls nothing.

export function create() {
  return {
    model: 'mock',
    async chat({ system = '', messages }) {
      const last = messages[messages.length - 1]
      const parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
      const hasImage = parts.some((p) => p.type === 'image')
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ')

      if (hasImage) return 'A photo with some text overlay; looks like a product or promo (mock description).'
      if (/rank|pick the statuses/i.test(system)) {
        return '1. (mock) First status — matches your request.\n2. (mock) Second status — also relevant.'
      }
      return `(mock reply) You said: ${text.slice(0, 80)}`
    },
  }
}
