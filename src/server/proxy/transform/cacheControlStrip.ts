/**
 * Strip Anthropic-specific `cache_control` fields from the request body.
 *
 * OpenAI-compatible providers do not understand Anthropic's prompt caching
 * annotations (`cache_control` on system blocks, content blocks, and tools).
 * Leaving them in the transformed request wastes bandwidth and can cause
 * validation errors on some providers.
 */

import type { AnthropicRequest, AnthropicContentBlock } from './types.js'

/**
 * Remove all `cache_control` properties from an Anthropic request body.
 * Returns a new object — the input is not mutated.
 */
export function stripCacheControl(body: AnthropicRequest): AnthropicRequest {
  const result: AnthropicRequest = {
    ...body,
    system: stripSystemCacheControl(body.system),
    messages: body.messages.map(stripMessageCacheControl),
    tools: body.tools ? body.tools.map(stripToolCacheControl) : undefined,
  }
  return result
}

function stripSystemCacheControl(
  system: AnthropicRequest['system'],
): AnthropicRequest['system'] {
  if (!system) return system
  if (typeof system === 'string') return system
  return system.map(block => {
    if (!('cache_control' in block)) return block
    const { cache_control: _, ...rest } = block
    return rest as typeof block
  })
}

function stripMessageCacheControl(msg: AnthropicRequest['messages'][number]): AnthropicRequest['messages'][number] {
  if (typeof msg.content === 'string') return msg
  return {
    ...msg,
    content: (msg.content as AnthropicContentBlock[]).map(stripBlockCacheControl),
  }
}

function stripBlockCacheControl(block: AnthropicContentBlock): AnthropicContentBlock {
  if (!('cache_control' in (block as Record<string, unknown>))) return block
  const { cache_control: _, ...rest } = block as Record<string, unknown> & { cache_control?: unknown }
  return rest as AnthropicContentBlock
}

function stripToolCacheControl(tool: NonNullable<AnthropicRequest['tools']>[number]): NonNullable<AnthropicRequest['tools']>[number] {
  if (!('cache_control' in tool)) return tool
  const { cache_control: _, ...rest } = tool
  return rest as NonNullable<AnthropicRequest['tools']>[number]
}
