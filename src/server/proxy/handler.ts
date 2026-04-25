/**
 * Proxy Handler — protocol-translating reverse proxy for OpenAI-compatible APIs.
 *
 * Receives Anthropic Messages API requests from the CLI, transforms them to
 * OpenAI Chat Completions or Responses API format, forwards to the upstream
 * provider, and transforms the response back to Anthropic format.
 *
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import { ProviderService } from '../services/providerService.js'
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicRequest } from './transform/types.js'
import { stripCacheControl } from './transform/cacheControlStrip.js'
import { adaptThinkingInRequest, resolveThinkingStrategy } from './transform/thinkingAdapter.js'
import { recordRequestForCacheSim, patchResponseUsage } from './cache/promptCacheSim.js'
import { patchStreamCacheUsage } from './cache/streamCachePatch.js'

const providerService = new ProviderService()

/**
 * Anthropic-specific beta headers that have no meaning for OpenAI-compatible
 * providers. Sending these to non-Anthropic endpoints can cause 400 errors
 * or silently break prompt caching logic.
 */
const ANTHROPIC_ONLY_BETA_HEADERS = new Set([
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'context-1m-2025-08-07',
  'context-management-2025-06-27',
  'structured-outputs-2025-12-15',
  'prompt-caching-scope-2026-01-05',
  'redact-thinking-2026-02-12',
  'token-efficient-tools-2026-03-28',
  'summarize-connector-text-2026-03-13',
  'afk-mode-2026-01-31',
  'cli-internal-2026-02-09',
  'advisor-tool-2026-03-01',
  'effort-2025-11-24',
  'task-budgets-2026-03-13',
  'fast-mode-2026-02-01',
  'web-search-2025-03-05',
  'advanced-tool-use-2025-11-20',
  'tool-search-tool-2025-10-19',
])

/**
 * Filter the `anthropic-beta` header value, removing Anthropic-specific beta
 * headers that are not understood by OpenAI-compatible providers.
 * Returns the filtered header value, or undefined if nothing remains.
 */
function filterAnthropicBetaHeader(rawHeader: string | null): string | undefined {
  if (!rawHeader) return undefined
  const betas = rawHeader.split(',').map(b => b.trim()).filter(Boolean)
  const filtered = betas.filter(b => !ANTHROPIC_ONLY_BETA_HEADERS.has(b))
  return filtered.length > 0 ? filtered.join(',') : undefined
}

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  const providerMatch = url.pathname.match(/^\/proxy\/providers\/([^/]+)\/v1\/messages$/)
  const providerId = providerMatch ? decodeURIComponent(providerMatch[1]!) : undefined
  const isActiveProxyPath = url.pathname === '/proxy/v1/messages'

  // Only handle POST /proxy/v1/messages or POST /proxy/providers/:providerId/v1/messages
  if (req.method !== 'POST' || (!isActiveProxyPath && !providerMatch)) {
    return Response.json(
      {
        error: 'Not Found',
        message: 'Proxy only handles POST /proxy/v1/messages and POST /proxy/providers/:providerId/v1/messages',
      },
      { status: 404 },
    )
  }

  // Read active/default provider config or an explicitly-scoped provider config.
  const config = await providerService.getProviderForProxy(providerId)
  if (!config) {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" is not configured for proxy`
            : 'No active provider configured for proxy',
        },
      },
      { status: 400 },
    )
  }

  if (config.apiFormat === 'anthropic') {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" uses anthropic format — proxy not needed`
            : 'Active provider uses anthropic format — proxy not needed',
        },
      },
      { status: 400 },
    )
  }

  // Parse request body
  let body: AnthropicRequest
  try {
    body = (await req.json()) as AnthropicRequest
  } catch {
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON in request body' } },
      { status: 400 },
    )
  }

  // Strip cache_control from the request body — OpenAI-compatible providers
  // do not support Anthropic's prompt caching annotations.
  body = stripCacheControl(body)

  // Adapt thinking/reasoning based on model capabilities
  const thinkingStrategy = resolveThinkingStrategy(body.model, config.modelCapabilities)
  body = adaptThinkingInRequest(body, thinkingStrategy)

  // Record request state for client-side cache simulation
  const cacheInfo = recordRequestForCacheSim(providerId, body)

  const isStream = body.stream === true
  const baseUrl = config.baseUrl.replace(/\/+$/, '')

  // Filter anthropic-beta header for upstream request
  const filteredBeta = filterAnthropicBetaHeader(req.headers.get('anthropic-beta'))

  try {
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream, filteredBeta, providerId, cacheInfo)
    } else {
      return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream, filteredBeta, providerId, cacheInfo)
    }
  } catch (err) {
    console.error('[Proxy] Upstream request failed:', err)
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 502 },
    )
  }
}

async function handleOpenaiChat(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  filteredBeta?: string,
  providerId?: string,
  cacheInfo?: { isCacheHit: boolean },
): Promise<Response> {
  const transformed = anthropicToOpenaiChat(body)
  const url = `${baseUrl}/v1/chat/completions`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  // Forward any remaining (non-Anthropic-specific) beta headers
  if (filteredBeta) {
    headers['anthropic-beta'] = filteredBeta
  }

  const upstream = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(transformed),
    signal: isStream ? AbortSignal.timeout(30_000) : AbortSignal.timeout(300_000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
        },
      },
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const anthropicStream = openaiChatStreamToAnthropic(upstream.body, body.model)
    const patchedStream = cacheInfo
      ? patchStreamCacheUsage(anthropicStream, cacheInfo)
      : anthropicStream
    return new Response(patchedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming — patch usage with cache simulation
  const responseBody = await upstream.json()
  let anthropicResponse = openaiChatToAnthropic(responseBody, body.model)
  if (cacheInfo) {
    anthropicResponse = patchResponseUsage(providerId, body.model, anthropicResponse, cacheInfo)
  }
  return Response.json(anthropicResponse)
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  filteredBeta?: string,
  providerId?: string,
  cacheInfo?: { isCacheHit: boolean },
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body)
  const url = `${baseUrl}/v1/responses`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
  // Forward any remaining (non-Anthropic-specific) beta headers
  if (filteredBeta) {
    headers['anthropic-beta'] = filteredBeta
  }

  const upstream = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(transformed),
    signal: isStream ? AbortSignal.timeout(30_000) : AbortSignal.timeout(300_000),
  })

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
        },
      },
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const anthropicStream = openaiResponsesStreamToAnthropic(upstream.body, body.model)
    const patchedStream = cacheInfo
      ? patchStreamCacheUsage(anthropicStream, cacheInfo)
      : anthropicStream
    return new Response(patchedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming — patch usage with cache simulation
  const responseBody = await upstream.json()
  let anthropicResponse = openaiResponsesToAnthropic(responseBody, body.model)
  if (cacheInfo) {
    anthropicResponse = patchResponseUsage(providerId, body.model, anthropicResponse, cacheInfo)
  }
  return Response.json(anthropicResponse)
}
