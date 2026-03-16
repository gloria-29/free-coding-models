/**
 * @file src/proxy-topology.js
 * @description Builds the proxy account topology from config + merged models.
 *
 * 📖 Extracted from opencode.js so the standalone daemon can reuse the same
 *    topology builder without importing TUI-specific modules (chalk, render-table).
 *
 * 📖 The topology is an array of "account" objects — one per API key per model.
 *    The proxy server uses these accounts for multi-key rotation and load balancing.
 *
 * @functions
 *   → buildProxyTopologyFromConfig(fcmConfig, mergedModels, sources) — build accounts + proxyModels
 *   → buildMergedModelsForDaemon() — standalone helper to build merged models without TUI
 *
 * @exports buildProxyTopologyFromConfig, buildMergedModelsForDaemon
 * @see src/opencode.js — TUI-side proxy lifecycle that delegates here
 * @see bin/fcm-proxy-daemon.js — standalone daemon that uses this directly
 */

import { resolveApiKeys } from './config.js'
import { resolveCloudflareUrl } from './ping.js'

/**
 * 📖 Build the account list and proxy model catalog from config + merged models.
 *
 * Each account represents one API key for one model on one provider.
 * The proxy uses this list for rotation, sticky sessions, and failover.
 *
 * @param {object} fcmConfig — live config from loadConfig()
 * @param {Array} mergedModels — output of buildMergedModels(MODELS)
 * @param {object} sourcesMap — the sources object keyed by providerKey
 * @returns {{ accounts: Array, proxyModels: Record<string, { name: string }> }}
 */
export function buildProxyTopologyFromConfig(fcmConfig, mergedModels, sourcesMap) {
  const accounts = []
  const proxyModels = {}

  for (const merged of mergedModels) {
    proxyModels[merged.slug] = { name: merged.label }

    for (const providerEntry of merged.providers) {
      // 📖 Trim whitespace from API keys — common copy-paste error that causes silent auth failures
      const keys = resolveApiKeys(fcmConfig, providerEntry.providerKey)
        .map(k => typeof k === 'string' ? k.trim() : k)
        .filter(Boolean)
      const providerSource = sourcesMap[providerEntry.providerKey]
      if (!providerSource) continue

      const rawUrl = resolveCloudflareUrl(providerSource.url || '')
      // 📖 Skip provider if URL resolution fails (e.g. undefined or empty URL)
      if (!rawUrl) continue
      const baseUrl = rawUrl.replace(/\/chat\/completions$/, '')

      keys.forEach((apiKey, keyIdx) => {
        accounts.push({
          id: `${providerEntry.providerKey}/${merged.slug}/${keyIdx}`,
          providerKey: providerEntry.providerKey,
          proxyModelId: merged.slug,
          modelId: providerEntry.modelId,
          url: baseUrl,
          apiKey,
        })
      })
    }
  }

  return { accounts, proxyModels }
}

/**
 * 📖 Build merged models from sources without TUI dependencies.
 * 📖 Used by the standalone daemon to get the full model catalog.
 *
 * @returns {Promise<Array>} merged model list
 */
export async function buildMergedModelsForDaemon() {
  const { MODELS } = await import('../sources.js')
  const { buildMergedModels } = await import('./model-merger.js')
  return buildMergedModels(MODELS)
}
