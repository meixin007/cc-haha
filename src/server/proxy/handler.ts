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
import { getProxyModelCapabilities } from '../services/proxyModelCapabilities.js'

const providerService = new ProviderService()

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

  // Performance optimizations: thinking adaptation, cache stripping, and cache simulation
  const modelCaps = getProxyModelCapabilities(body.model)
  const thinkingStrategy = resolveThinkingStrategy(body.model, modelCaps)
  body = adaptThinkingInRequest(body, thinkingStrategy)
  body = stripCacheControl(body)

  const cacheInfo = recordRequestForCacheSim(providerId, body)

  const isStream = body.stream === true
  const baseUrl = config.baseUrl.replace(/\/+$/, '')

  try {
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, config.apiKey, isStream, providerId, cacheInfo)
    } else {
      return await handleOpenaiResponses(body, baseUrl, config.apiKey, isStream, providerId, cacheInfo)
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
  providerId: string | undefined,
  cacheInfo: { isCacheHit: boolean },
): Promise<Response> {
  const transformed = anthropicToOpenaiChat(body)
  const url = `${baseUrl}/v1/chat/completions`

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
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
    let anthropicStream = openaiChatStreamToAnthropic(upstream.body, body.model)
    // Patch stream with simulated cache usage
    anthropicStream = patchStreamCacheUsage(anthropicStream, cacheInfo)
    return new Response(anthropicStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  let responseBody = await upstream.json() as Record<string, unknown>
  const anthropicResponse = openaiChatToAnthropic(responseBody, body.model)
  const patchedResponse = patchResponseUsage(providerId, body.model, anthropicResponse, cacheInfo)
  return Response.json(patchedResponse)
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  apiKey: string,
  isStream: boolean,
  providerId: string | undefined,
  cacheInfo: { isCacheHit: boolean },
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body)
  const url = `${baseUrl}/v1/responses`

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
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
    let anthropicStream = openaiResponsesStreamToAnthropic(upstream.body, body.model)
    // Patch stream with simulated cache usage
    anthropicStream = patchStreamCacheUsage(anthropicStream, cacheInfo)
    return new Response(anthropicStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  let responseBody = await upstream.json() as Record<string, unknown>
  const anthropicResponse = openaiResponsesToAnthropic(responseBody, body.model)
  const patchedResponse = patchResponseUsage(providerId, body.model, anthropicResponse, cacheInfo)
  return Response.json(patchedResponse)
}
