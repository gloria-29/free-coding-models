/**
 * @file web/server.js
 * @description HTTP server for the free-coding-models Web Dashboard V2.
 *
 * Reuses the existing ping engine, model sources, and utility functions
 * from the CLI tool. Serves the dashboard HTML/CSS/JS and provides
 * API endpoints + SSE for real-time ping data.
 *
 * Endpoints:
 *   GET /              → Dashboard HTML
 *   GET /styles.css    → Dashboard styles
 *   GET /app.js        → Dashboard client JS
 *   GET /api/models    → All model metadata (JSON)
 *   GET /api/config    → Current config (sanitized — masked keys)
 *   GET /api/key/:prov → Reveal a provider's full API key
 *   GET /api/events    → SSE stream of live ping results
 *   POST /api/settings → Update API keys / provider toggles
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sources, MODELS } from '../sources.js'
import { loadConfig, getApiKey, saveConfig, isProviderEnabled } from '../src/config.js'
import { ping } from '../src/ping.js'
import {
  getAvg, getVerdict, getUptime, getP95, getJitter,
  getStabilityScore, TIER_ORDER
} from '../src/utils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── State ───────────────────────────────────────────────────────────────────

let config = loadConfig()

// Build results array from MODELS (same shape as the TUI)
const results = MODELS.map(([modelId, label, tier, sweScore, ctx, providerKey], idx) => ({
  idx: idx + 1,
  modelId,
  label,
  tier,
  sweScore,
  ctx,
  providerKey,
  status: 'pending',
  pings: [],
  httpCode: null,
  origin: sources[providerKey]?.name || providerKey,
  url: sources[providerKey]?.url || null,
  cliOnly: sources[providerKey]?.cliOnly || false,
  zenOnly: sources[providerKey]?.zenOnly || false,
}))

// SSE clients
const sseClients = new Set()

// ─── Ping Loop ───────────────────────────────────────────────────────────────
// Uses recursive setTimeout (not setInterval) to prevent overlapping rounds.
// Each new round starts only after the previous one completes.

let pingRound = 0
let pingLoopRunning = false

async function pingAllModels() {
  if (pingLoopRunning) return // guard against overlapping calls
  pingLoopRunning = true
  pingRound++
  const batchSize = 30
  // P2 fix: honor provider enabled flags — skip disabled providers
  const modelsToPing = results.filter(r =>
    !r.cliOnly && r.url && isProviderEnabled(config, r.providerKey)
  )

  for (let i = 0; i < modelsToPing.length; i += batchSize) {
    const batch = modelsToPing.slice(i, i + batchSize)
    const promises = batch.map(async (r) => {
      const apiKey = getApiKey(config, r.providerKey)
      try {
        const result = await ping(apiKey, r.modelId, r.providerKey, r.url)
        r.httpCode = result.code
        if (result.code === '200') {
          r.status = 'up'
          r.pings.push({ ms: result.ms, code: result.code })
        } else if (result.code === '401') {
          r.status = 'up'
          r.pings.push({ ms: result.ms, code: result.code })
        } else if (result.code === '429') {
          r.status = 'up'
          r.pings.push({ ms: result.ms, code: result.code })
        } else if (result.code === '000') {
          r.status = 'timeout'
        } else {
          r.status = 'down'
          r.pings.push({ ms: result.ms, code: result.code })
        }
        // Keep only last 60 pings
        if (r.pings.length > 60) r.pings = r.pings.slice(-60)
      } catch {
        r.status = 'timeout'
      }
    })
    await Promise.all(promises)
  }

  // Broadcast update to all SSE clients
  broadcastUpdate()
  pingLoopRunning = false
}

function broadcastUpdate() {
  const data = JSON.stringify(getModelsPayload())
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`)
    } catch {
      sseClients.delete(client)
    }
  }
}

function getModelsPayload() {
  return results.map(r => ({
    idx: r.idx,
    modelId: r.modelId,
    label: r.label,
    tier: r.tier,
    sweScore: r.sweScore,
    ctx: r.ctx,
    providerKey: r.providerKey,
    origin: r.origin,
    status: r.status,
    httpCode: r.httpCode,
    cliOnly: r.cliOnly,
    zenOnly: r.zenOnly,
    avg: getAvg(r),
    verdict: getVerdict(r),
    uptime: getUptime(r),
    p95: getP95(r),
    jitter: getJitter(r),
    stability: getStabilityScore(r),
    latestPing: r.pings.length > 0 ? r.pings[r.pings.length - 1].ms : null,
    latestCode: r.pings.length > 0 ? r.pings[r.pings.length - 1].code : null,
    pingHistory: r.pings.slice(-20).map(p => ({ ms: p.ms, code: p.code })),
    pingCount: r.pings.length,
    hasApiKey: !!getApiKey(config, r.providerKey),
  }))
}

function getConfigPayload() {
  // Sanitize — show which providers have keys, but not the actual keys
  const providers = {}
  for (const [key, src] of Object.entries(sources)) {
    const rawKey = getApiKey(config, key)
    providers[key] = {
      name: src.name,
      hasKey: !!rawKey,
      maskedKey: rawKey ? maskApiKey(rawKey) : null,
      enabled: isProviderEnabled(config, key),
      modelCount: src.models?.length || 0,
      cliOnly: src.cliOnly || false,
    }
  }
  return { providers, totalModels: MODELS.length }
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return ''
  if (key.length <= 8) return '••••••••'
  return '••••••••' + key.slice(-4)
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

function serveFile(res, filename, contentType) {
  try {
    const content = readFileSync(join(__dirname, filename), 'utf8')
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

function handleRequest(req, res) {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)

  // ─── API: Reveal full key for a provider ───
  const keyMatch = url.pathname.match(/^\/api\/key\/(.+)$/)
  if (keyMatch) {
    const providerKey = decodeURIComponent(keyMatch[1])
    const rawKey = getApiKey(config, providerKey)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ key: rawKey || null }))
    return
  }

  switch (url.pathname) {
    case '/':
      serveFile(res, 'index.html', 'text/html; charset=utf-8')
      break

    case '/styles.css':
      serveFile(res, 'styles.css', 'text/css; charset=utf-8')
      break

    case '/app.js':
      serveFile(res, 'app.js', 'application/javascript; charset=utf-8')
      break

    case '/api/models':
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getModelsPayload()))
      break

    case '/api/config':
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getConfigPayload()))
      break

    case '/api/events':
      // SSE endpoint
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      res.write(`data: ${JSON.stringify(getModelsPayload())}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      break

    case '/api/settings':
      if (req.method === 'POST') {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
          try {
            const settings = JSON.parse(body)
            if (settings.apiKeys) {
              for (const [key, value] of Object.entries(settings.apiKeys)) {
                if (value) config.apiKeys[key] = value
                else delete config.apiKeys[key]
              }
            }
            if (settings.providers) {
              for (const [key, value] of Object.entries(settings.providers)) {
                if (!config.providers[key]) config.providers[key] = {}
                config.providers[key].enabled = value.enabled !== false
              }
            }
            // P2 fix: catch saveConfig failures and report to client
            try {
              saveConfig(config)
            } catch (saveErr) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ success: false, error: 'Failed to save config: ' + saveErr.message }))
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          }
        })
      } else {
        res.writeHead(405)
        res.end('Method Not Allowed')
      }
      break

    default:
      res.writeHead(404)
      res.end('Not Found')
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export async function startWebServer(port = 3333) {
  const server = createServer(handleRequest)

  server.listen(port, () => {
    console.log()
    console.log(`  ⚡ free-coding-models Web Dashboard`)
    console.log(`  🌐 http://localhost:${port}`)
    console.log(`  📊 Monitoring ${results.filter(r => !r.cliOnly).length} models across ${Object.keys(sources).length} providers`)
    console.log()
    console.log(`  Press Ctrl+C to stop`)
    console.log()
  })

  // P1 fix: serialize ping rounds — each round starts only after the
  // previous one finishes, preventing overlapping concurrent mutations.
  async function schedulePingLoop() {
    await pingAllModels()
    setTimeout(schedulePingLoop, 10_000)
  }
  schedulePingLoop()

  return server
}
