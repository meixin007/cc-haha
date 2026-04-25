/**
 * Cache Adapter — bridges Anthropic's cache_control semantics to
 * third-party provider-specific cache mechanisms.
 *
 * Different providers support prompt caching in different ways:
 *   - OpenAI:   `extra_headers["anthropic-beta"]` for cached prompt support (limited)
 *   - DeepSeek: Native prompt caching via `cache` parameter in messages
 *   - Other providers: No cache support, simulation only
 *
 * This adapter:
 *   1. Detects the provider type from the request/model name
 *   2. Applies provider-specific cache headers/parameters
 *   3. Falls back to simulation if no native cache is available
 */

import type { AnthropicRequest, OpenAIChatRequest } from '../transform/types.js'

export type CacheAdapter = {
  addCacheControl(body: OpenAIChatRequest, isLast: boolean): void
  supportsNativeCache: boolean
  cacheHitRatio: number
}

/**
 * OpenAI-compatible cache adapter.
 * OpenAI's Chat Completions API does not support prompt caching directly,
 * but Responses API (o-series models) may support it in the future.
 * For now, this adapter only adds metadata hints — no actual cache optimization.
 */
class OpenAICacheAdapter implements CacheAdapter {
  supportsNativeCache = false
  cacheHitRatio = 0.70

  addCacheControl(body: OpenAIChatRequest, isLast: boolean): void {
    if (isLast && body.messages.length > 0) {
      const lastMsg = body.messages[body.messages.length - 1]
      if (lastMsg && typeof lastMsg === 'object' && !('cache_control' in lastMsg)) {
        ;(lastMsg as Record<string, unknown>).metadata = {
          ...(lastMsg as Record<string, unknown>).metadata,
          cache_hint: 'ephemeral',
        }
      }
    }
  }
}

/**
 * DeepSeek cache adapter.
 * DeepSeek supports prompt caching through the `cache` field in messages.
 * When enabled, the system prompt and tools can be cached across requests.
 */
class DeepSeekCacheAdapter implements CacheAdapter {
  supportsNativeCache = true
  cacheHitRatio = 0.75

  addCacheControl(body: OpenAIChatRequest, isLast: boolean): void {
    if (isLast && body.messages.length > 0) {
      const lastMsg = body.messages[body.messages.length - 1]
      if (lastMsg && typeof lastMsg === 'object') {
        ;(lastMsg as Record<string, unknown>).cache = true
      }
    }
  }
}

/**
 * GLM cache adapter.
 * GLM models support basic prompt caching through the `cache` parameter.
 */
class GLMCacheAdapter implements CacheAdapter {
  supportsNativeCache = true
  cacheHitRatio = 0.70

  addCacheControl(body: OpenAIChatRequest, isLast: boolean): void {
    if (isLast && body.messages.length > 0) {
      const lastMsg = body.messages[body.messages.length - 1]
      if (lastMsg && typeof lastMsg === 'object') {
        ;(lastMsg as Record<string, unknown>).cache = true
      }
    }
  }
}

/**
 * Fallback adapter — no native cache support, simulation only.
 */
class FallbackCacheAdapter implements CacheAdapter {
  supportsNativeCache = false
  cacheHitRatio = 0.65

  addCacheControl(_body: OpenAIChatRequest, _isLast: boolean): void {
    // No-op: provider does not support caching
  }
}

/**
 * Provider-specific cache adapter cache.
 * Key: provider/model identifier prefix
 */
const adapterCache: Record<string, CacheAdapter> = {
  openai: new OpenAICacheAdapter(),
  o1: new OpenAICacheAdapter(),
  o3: new OpenAICacheAdapter(),
  o4: new OpenAICacheAdapter(),
  deepseek: new DeepSeekCacheAdapter(),
  glm: new GLMCacheAdapter(),
  cogview: new GLMCacheAdapter(),
}

/**
 * Get the appropriate cache adapter for a given model.
 */
export function getCacheAdapterForModel(model: string): CacheAdapter {
  const lower = model.toLowerCase()

  // Check for exact prefix matches
  for (const [prefix, adapter] of Object.entries(adapterCache)) {
    if (lower.startsWith(prefix) || lower.includes(prefix)) {
      return adapter
    }
  }

  return new FallbackCacheAdapter()
}

/**
 * Apply cache control to an OpenAI-compatible request body.
 * This modifies the body in place to add provider-specific cache parameters.
 */
export function applyCacheControl(body: OpenAIChatRequest, model: string): void {
  const adapter = getCacheAdapterForModel(model)

  // Apply cache control to the last message (typical pattern for Anthropic cache_control)
  adapter.addCacheControl(body, true)
}

/**
 * Get the expected cache hit ratio for a given model.
 * This is used for simulation when native caching is not available.
 */
export function getCacheHitRatioForModel(model: string): number {
  const adapter = getCacheAdapterForModel(model)
  return adapter.cacheHitRatio
}

/**
 * Check if a model supports native caching.
 */
export function supportsNativeCache(model: string): boolean {
  const adapter = getCacheAdapterForModel(model)
  return adapter.supportsNativeCache
}
