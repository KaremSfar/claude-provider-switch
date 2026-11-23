// Translation layer for the Copilot gateway.
//
// A `thinking` block carries a signature that only the model which wrote it can verify.
// When a conversation moves between models (/model, or `claude --continue` on an old
// session), the next model rejects the foreign signature: Claude models answer 400
// "Invalid `signature` in `thinking` block" to a Gemini turn.
//
// Tested against every model on the gateway: with the thinking blocks of earlier assistant
// turns removed, a tool turn from any model is accepted by every model, its own included.
//
// Returns the rewritten request body, or undefined when nothing needs to change.
export function stripThinking(body: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const req = parsed as { messages?: unknown }
  if (!Array.isArray(req.messages)) return undefined

  let changed = false
  const messages: unknown[] = []
  for (const m of req.messages as unknown[]) {
    const msg = m as { role?: string; content?: unknown } | null
    if (msg === null || msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      messages.push(m)
      continue
    }
    const content = (msg.content as unknown[]).filter(b => {
      const type = (b as { type?: string } | null)?.type
      return type !== 'thinking' && type !== 'redacted_thinking'
    })
    if (content.length === msg.content.length) {
      messages.push(m)
      continue
    }
    changed = true
    // A turn that was only thinking would be an empty message, which the API refuses.
    if (content.length > 0) messages.push({ ...msg, content })
  }
  return changed ? JSON.stringify({ ...req, messages }) : undefined
}
