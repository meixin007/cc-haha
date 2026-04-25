/**
 * Stream cache patching — injects simulated cache usage data into
 * Anthropic SSE streaming responses.
 *
 * For non-streaming responses, `patchResponseUsage` in promptCacheSim.ts
 * directly modifies the response object. For streaming, we need to intercept
 * the `message_start` SSE event and patch its `usage` field before forwarding.
 */

/**
 * Transform a ReadableStream of Anthropic SSE events, patching the
 * `message_start` event's usage data with simulated cache tokens.
 */
export function patchStreamCacheUsage(
  upstream: ReadableStream<Uint8Array>,
  cacheInfo: { isCacheHit: boolean },
): ReadableStream<Uint8Array> {
  if (!cacheInfo.isCacheHit) return upstream

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ''
  let patched = false

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      let errored = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith(':')) {
              controller.enqueue(encoder.encode(line + '\n'))
              continue
            }

            // Only patch the message_start event (once)
            if (!patched && trimmed.startsWith('data: ')) {
              try {
                const data = JSON.parse(trimmed.slice(6))
                if (data.type === 'message_start' && data.message?.usage) {
                  patched = true
                  const usage = data.message.usage
                  const totalInput = usage.input_tokens || 0

                  // Simulate 70% cache hit ratio for system+tools
                  const CACHE_RATIO = 0.70
                  const cacheReadTokens = Math.floor(totalInput * CACHE_RATIO)
                  const nonCachedInput = totalInput - cacheReadTokens

                  data.message.usage = {
                    ...usage,
                    input_tokens: nonCachedInput,
                    cache_read_input_tokens: cacheReadTokens,
                    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
                  }

                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n`))
                  continue
                }
              } catch {
                // Not valid JSON, forward as-is
              }
            }

            controller.enqueue(encoder.encode(line + '\n'))
          }
        }
      } catch (err) {
        errored = true
        controller.error(err)
      } finally {
        // Flush remaining buffer
        if (buffer && !errored) {
          controller.enqueue(encoder.encode(buffer))
        }
        if (!errored) controller.close()
      }
    },
  })
}
