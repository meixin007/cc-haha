/**
 * Proxy Model Capabilities — provides model capability overrides for
 * non-Anthropic providers.
 *
 * When the CLI is connected through a proxy provider (OpenAI-compatible),
 * the hardcoded Anthropic model parameters in `getContextWindowForModel` and
 * `getModelMaxOutputTokens` are wrong. This module reads the provider's
 * declared `modelCapabilities` and exposes them to the CLI process via
 * environment variables that the compact system respects.
 *
 * Flow:
 *   1. ProviderService writes `modelCapabilities` into the provider config.
 *   2. On activation, `buildManagedEnv` injects env vars:
 *      - CLAUDE_CODE_MAX_CONTEXT_TOKENS  → contextWindow
 *      - CLAUDE_CODE_MAX_OUTPUT_TOKENS   → maxOutputTokens
 *   3. The CLI's compact system reads these env vars natively.
 */

import type { ModelCapabilities } from '../types/provider.js'

/**
 * Well-known model capability presets for popular non-Anthropic providers.
 * These can be used as defaults when the user doesn't specify custom values.
 */
export const MODEL_CAPABILITY_PRESETS: Record<string, ModelCapabilities> = {
  // DeepSeek
  'deepseek-chat': { contextWindow: 64_000, maxOutputTokens: 8_192, supportsThinking: false },
  'deepseek-reasoner': { contextWindow: 64_000, maxOutputTokens: 8_192, supportsThinking: true },

  // Qwen
  'qwen-max': { contextWindow: 32_000, maxOutputTokens: 8_192, supportsThinking: false },
  'qwen-plus': { contextWindow: 128_000, maxOutputTokens: 8_192, supportsThinking: false },
  'qwen-turbo': { contextWindow: 1_000_000, maxOutputTokens: 8_192, supportsThinking: false },
  'qwq-32b': { contextWindow: 128_000, maxOutputTokens: 8_192, supportsThinking: true },

  // GLM
  'glm-4-plus': { contextWindow: 128_000, maxOutputTokens: 4_096, supportsThinking: false },
  'glm-4-flash': { contextWindow: 128_000, maxOutputTokens: 4_096, supportsThinking: false },

  // Moonshot
  'moonshot-v1-8k': { contextWindow: 8_000, maxOutputTokens: 4_096, supportsThinking: false },
  'moonshot-v1-32k': { contextWindow: 32_000, maxOutputTokens: 4_096, supportsThinking: false },
  'moonshot-v1-128k': { contextWindow: 128_000, maxOutputTokens: 4_096, supportsThinking: false },

  // OpenAI
  'gpt-4o': { contextWindow: 128_000, maxOutputTokens: 16_384, supportsThinking: false },
  'gpt-4o-mini': { contextWindow: 128_000, maxOutputTokens: 16_384, supportsThinking: false },
  'o1': { contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true },
  'o1-mini': { contextWindow: 128_000, maxOutputTokens: 65_536, supportsThinking: true },
  'o3-mini': { contextWindow: 200_000, maxOutputTokens: 100_000, supportsThinking: true },

  // Llama
  'llama-3.3-70b': { contextWindow: 128_000, maxOutputTokens: 4_096, supportsThinking: false },
}

/**
 * Look up a model capability preset by model name (case-insensitive, partial match).
 */
export function findPresetForModel(modelId: string): ModelCapabilities | undefined {
  const lower = modelId.toLowerCase()
  // Exact match first
  if (MODEL_CAPABILITY_PRESETS[lower]) {
    return MODEL_CAPABILITY_PRESETS[lower]
  }
  // Partial match (model ID contains preset key)
  for (const [key, caps] of Object.entries(MODEL_CAPABILITY_PRESETS)) {
    if (lower.includes(key) || key.includes(lower)) {
      return caps
    }
  }
  return undefined
}

/**
 * Merge user-declared capabilities with auto-detected preset values.
 * User-declared values always take precedence.
 */
export function resolveModelCapabilities(
  modelId: string,
  declared?: ModelCapabilities,
): ModelCapabilities {
  const preset = findPresetForModel(modelId) ?? {}
  return {
    contextWindow: declared?.contextWindow ?? preset.contextWindow,
    maxOutputTokens: declared?.maxOutputTokens ?? preset.maxOutputTokens,
    supportsThinking: declared?.supportsThinking ?? preset.supportsThinking,
    supportsInterleavedThinking: declared?.supportsInterleavedThinking ?? preset.supportsInterleavedThinking,
  }
}
