/**
 * Thinking Adapter — dynamically adjusts thinking/reasoning strategy
 * based on the upstream provider's model capabilities.
 *
 * When using OpenAI-compatible providers through the proxy, the CLI sends
 * Anthropic-style thinking configurations that many providers don't support.
 * This module:
 *
 * 1. Detects whether the target model supports reasoning/thinking output.
 * 2. Strips `thinking` from the request if the model doesn't support it.
 * 3. Preserves thinking text in assistant messages by merging it into
 *    regular text content (prevents context loss on multi-turn conversations
 *    where previous thinking blocks would be silently dropped).
 */

import type { AnthropicRequest, AnthropicContentBlock, AnthropicMessage, OpenAIChatRequest } from './types.js'
import type { ModelCapabilities } from '../../types/provider.js'

export type ThinkingStrategy =
  | 'native'        // Model supports Anthropic-style thinking natively
  | 'budgeted'      // Model supports precise thinking budget (e.g., thinking.budget_tokens)
  | 'reasoningParam' // Model supports reasoning param (e.g., GLM thinking.enabled)
  | 'reasoning'     // Model supports OpenAI reasoning_effort (DeepSeek, etc.)
  | 'merged_text'   // Model has no reasoning support; merge thinking into text
  | 'disabled'      // Strip thinking entirely

export type ProviderCapability = {
  thinkingFormat: 'thinking_budget' | 'reasoning_params' | 'thinking_flag' | 'reasoning_content' | 'none'
  maxThinkingTokens?: number
}

export const defaultProviderCapability: Record<string, ProviderCapability> = {
  default: { thinkingFormat: 'reasoning_content' },
  glm: { thinkingFormat: 'thinking_flag', maxThinkingTokens: 32000 },
  deepseek: { thinkingFormat: 'thinking_budget' },
  openai_o: { thinkingFormat: 'reasoning_params' },
}

function loadProviderCapability(): Record<string, ProviderCapability> {
  const override = process.env.THINKING_PROVIDER_CAPABILITY
  if (override) {
    try {
      return JSON.parse(override) as Record<string, ProviderCapability>
    } catch {
      console.warn('[thinkingAdapter] Failed to parse THINKING_PROVIDER_CAPABILITY, using defaults')
    }
  }
  return defaultProviderCapability
}

let providerCapability = loadProviderCapability()

export function reloadProviderCapability(): void {
  providerCapability = loadProviderCapability()
}

/**
 * Determine the thinking strategy for a given model and its declared capabilities.
 */
export function resolveThinkingStrategy(
  model: string,
  capabilities?: ModelCapabilities,
): ThinkingStrategy {
  if (capabilities?.supportsThinking === true) {
    return 'reasoning'
  }

  const lower = model.toLowerCase()

  // OpenAI o-series: supports reasoning_params with precise budget
  if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4') || lower.startsWith('o-')) {
    return 'budgeted'
  }

  // GLM-5/6: supports thinking flag with budget limit
  if (lower.startsWith('glm') || lower.includes('cogview')) {
    return 'reasoningParam'
  }

  // DeepSeek Reasoner / QwQ / reasoning models: reasoning_content
  if (
    lower.includes('deepseek-reasoner') ||
    lower.includes('qwq') ||
    lower.includes('qwen3') ||
    lower.includes('think') ||
    lower.includes('reason')
  ) {
    return 'reasoning'
  }

  if (capabilities?.supportsThinking === false) {
    return 'merged_text'
  }

  // Default: merged_text (safe fallback)
  return 'merged_text'
}

/**
 * Get the provider capability for a given provider key.
 */
export function getProviderCapability(providerKey: string): ProviderCapability | undefined {
  return providerCapability[providerKey] ?? providerCapability['default']
}

/**
 * Determine if a model supports thinking budget beyond a threshold.
 */
export function getModelThinkingBudgetLimit(model: string): number {
  const lower = model.toLowerCase()
  const cap = providerCapability[lower.split('-')[0]?.split('_')[0] ?? 'default']
  return cap?.maxThinkingTokens ?? 32000
}

/**
 * Adapt the request's thinking configuration based on the strategy.
 * Returns the modified request (does not mutate the input).
 * 
 * For 'budgeted' and 'reasoningParam' strategies, thinking is preserved
 * for the transform layer to convert to the appropriate provider format.
 */
export function adaptThinkingInRequest(
  body: AnthropicRequest,
  strategy: ThinkingStrategy,
): AnthropicRequest {
  if (strategy === 'native') return body

  // For 'budgeted' and 'reasoningParam': preserve thinking for transform layer
  if (strategy === 'budgeted' || strategy === 'reasoningParam') {
    return body
  }

  if (strategy === 'reasoning') {
    // The transform layer will convert thinking → reasoning_effort
    return body
  }

  // Remove the `thinking` parameter for models that don't support it
  const { thinking: _, ...rest } = body

  // For 'merged_text' and 'disabled': strip thinking from request,
  // and merge any thinking blocks in assistant messages into text
  const adapted: AnthropicRequest = {
    ...rest,
    messages: body.messages.map(msg => mergeThinkingIntoText(msg)),
  }

  return adapted
}

/**
 * Merge thinking blocks in a message into regular text content.
 * For assistant messages with thinking blocks, the thinking text is
 * prepended to the text content in a collapsed format:
 *
 *   <thinking>
 *   ... thinking content ...
 *   </thinking>
 *
 *   ... regular text content ...
 *
 * This preserves the thinking context so multi-turn conversations don't
 * lose information that the model generated in previous turns.
 */
function mergeThinkingIntoText(msg: AnthropicMessage): AnthropicMessage {
  if (msg.role !== 'assistant') return msg
  if (typeof msg.content === 'string') return msg

  const blocks = msg.content as AnthropicContentBlock[]
  const thinkingParts: string[] = []
  const otherBlocks: AnthropicContentBlock[] = []

  for (const block of blocks) {
    if (block.type === 'thinking') {
      thinkingParts.push(block.thinking)
    } else {
      otherBlocks.push(block)
    }
  }

  if (thinkingParts.length === 0) return msg

  // Merge thinking into the first text block, or create a new one
  const thinkingText = thinkingParts.join('\n')
  const thinkingBlock = `<thinking>\n${thinkingText}\n</thinking>`

  if (otherBlocks.length > 0 && otherBlocks[0]!.type === 'text') {
    // Prepend thinking to existing text block
    otherBlocks[0] = {
      ...otherBlocks[0]!,
      text: `${thinkingBlock}\n\n${(otherBlocks[0] as { type: 'text'; text: string }).text}`,
    }
  } else {
    // Insert a new text block with the thinking content
    otherBlocks.unshift({ type: 'text', text: thinkingBlock })
  }

  return { ...msg, content: otherBlocks }
}
