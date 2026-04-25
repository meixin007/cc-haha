/**
 * Client-side Prompt Cache Simulation for the proxy layer.
 *
 * Anthropic's prompt caching reduces cost by caching the system prompt and
 * tool definitions across requests. OpenAI-compatible providers don't support
 * Anthropic's `cache_control` semantics, so the CLI's token tracking sees
 * every request as a cache miss.
 *
 * This module simulates prompt caching at the proxy layer:
 *   1. Computes a hash of the system prompt + tools for each request.
 *   2. If the hash matches the previous request (same provider+model),
 *      it patches the response's `usage` to report cache_read_input_tokens
 *      instead of raw input_tokens.
 *   3. This keeps the CLI's cost tracking and cache break detection working.
 *
 * Note: This is a *simulation* — it doesn't actually reduce upstream API
 * costs. The real benefit is:
 *   - Accurate cache break detection (promptCacheBreakDetection.ts)
 *   - Consistent token display in the CLI status line
 *   - Auto-compact triggers work correctly with simulated cache percentages
 */

import type { AnthropicRequest, AnthropicResponse } from './transform/types.js'

type CacheEntry = {
  systemHash: number
  toolsHash: number
  lastInputTokens: number
  timestamp: number
}

/**
 * Per-provider+model cache tracking.
 * Key format: `${providerId}::${model}`
 */
const cacheStore = new Map<string, CacheEntry>()

// Evict entries older than 10 minutes
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 50

function getCacheKey(providerId: string | undefined, model: string): string {
  return `${providerId ?? 'default'}::${model}`
}

function computeHash(data: unknown): number {
  const str = JSON.stringify(data)
  // Simple djb2 hash
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff
  }
  return hash >>> 0
}

function evictStale(): void {
  const now = Date.now()
  for (const [key, entry] of cacheStore) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cacheStore.delete(key)
    }
  }
  // Cap size
  if (cacheStore.size > MAX_CACHE_ENTRIES) {
    const entries = [...cacheStore.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)
    const toRemove = entries.slice(0, cacheStore.size - MAX_CACHE_ENTRIES)
    for (const [key] of toRemove) {
      cacheStore.delete(key)
    }
  }
}

/**
 * Record the current request's system/tools state and determine
 * whether it's a cache hit (same system+tools as previous request).
 *
 * Returns cache simulation info for response patching.
 */
export function recordRequestForCacheSim(
  providerId: string | undefined,
  body: AnthropicRequest,
): {
  isCacheHit: boolean
  systemHash: number
  toolsHash: number
} {
  evictStale()

  const systemHash = computeHash(body.system)
  const toolsHash = computeHash(body.tools)
  const key = getCacheKey(providerId, body.model)

  const prev = cacheStore.get(key)

  const isCacheHit = prev != null
    && prev.systemHash === systemHash
    && prev.toolsHash === toolsHash

  // Update cache entry
  cacheStore.set(key, {
    systemHash,
    toolsHash,
    lastInputTokens: 0, // Will be updated by patchResponseUsage
    timestamp: Date.now(),
  })

  return { isCacheHit, systemHash, toolsHash }
}

/**
 * Patch an Anthropic response's usage data to simulate prompt caching.
 *
 * When the proxy detects a cache hit (same system+tools as the previous
 * request for this provider+model), it splits the reported `input_tokens`
 * into `cache_read_input_tokens` + reduced `input_tokens`, simulating
 * what the Anthropic API would have returned.
 *
 * System prompt + tool definitions typically account for 60-80% of
 * input tokens in Claude Code requests.
 */
export function patchResponseUsage(
  providerId: string | undefined,
  model: string,
  response: AnthropicResponse,
  cacheInfo: { isCacheHit: boolean },
): AnthropicResponse {
  if (!cacheInfo.isCacheHit) return response

  const usage = response.usage
  const totalInput = usage.input_tokens

  // Estimate the cached portion as ~70% of input tokens.
  // This is a rough heuristic — the actual percentage varies by session
  // length, but system + tools typically dominate the input.
  const CACHE_RATIO = 0.70
  const cacheReadTokens = Math.floor(totalInput * CACHE_RATIO)
  const nonCachedInput = totalInput - cacheReadTokens

  return {
    ...response,
    usage: {
      ...usage,
      input_tokens: nonCachedInput,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  }
}

/**
 * Clear cache tracking for a specific provider+model.
 */
export function clearCacheForProvider(providerId: string | undefined, model: string): void {
  cacheStore.delete(getCacheKey(providerId, model))
}

/**
 * Clear all cache tracking entries.
 */
export function clearAllCaches(): void {
  cacheStore.clear()
}
