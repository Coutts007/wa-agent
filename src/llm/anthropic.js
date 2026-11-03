// Anthropic (Claude) adapter. Requires: npm i @anthropic-ai/sdk ; env ANTHROPIC_API_KEY (or LLM_API_KEY).
// Models: claude-haiku-5-5 (cheapest, fast) · claude-sonnet-5-5 (balanced) · claude-opus-5-5.
// Personal keys (sk-ant-usr-...) that aren't tied to one workspace also need
// ANTHROPIC_WORKSPACE_ID=wrkspc_... (Console -> Workspaces); workspace-scoped keys don't.

export function create(cfg) {
  const model = cfg.model || 'claude-sonnet-5-5'
  let client

  async function getClient() {
    if (!client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID
      client = new Anthropic({
        apiKey: cfg.apiKey || process.env.ANTHROPIC_API_KEY,
        ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
      })
    }
    return client
  }

  const toBlocks = (content) =>
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : content.map((p) =>
          p.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } }
            : { type: 'text', text: p.text },
        )

  return {
    model,
    async chat({ system, messages, maxTokens }) {
      const c = await getClient()
      const res = await c.messages.create({
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: messages.map((m) => ({ role: m.role, content: toBlocks(m.content) })),
      })
      return res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
    },
  }
}
