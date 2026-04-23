/**
 * @file router-dashboard.js
 * @description TUI client, SSE reader, and renderer for the Smart Model Router dashboard.
 *
 * @details
 *   📖 This module is intentionally defensive: the dashboard talks to a local
 *   daemon that may be stopped, stale, mid-restart, or returning malformed JSON.
 *   Every public helper treats unexpected payloads as partial data instead of
 *   throwing into the render loop.
 *
 *   The dashboard uses polling for baseline reliability and an SSE stream for
 *   low-latency request/probe/circuit updates. Polling keeps the screen useful
 *   when `/stream/events` is unavailable, while SSE keeps the request log live.
 *
 * @functions
 *   → `openRouterDashboardOverlay` — Start polling/SSE and mark the overlay open
 *   → `closeRouterDashboardOverlay` — Close the overlay and stop dashboard I/O
 *   → `refreshRouterDashboardSnapshot` — Fetch `/health` + `/stats` safely
 *   → `startRouterDashboardEventStream` — Connect to `/stream/events`
 *   → `cycleRouterDashboardActiveSet` — Activate the next daemon set
 *   → `cycleRouterDashboardProbeMode` — Rotate eco/balanced/aggressive mode
 *   → `renderRouterDashboard` — Render the full-screen dashboard overlay
 *   → `normalizeRouterDashboardSnapshot` — Sanitize daemon payloads for rendering
 *   → `parseRouterDashboardSseFrame` — Parse one SSE frame
 *
 * @exports openRouterDashboardOverlay, closeRouterDashboardOverlay
 * @exports refreshRouterDashboardSnapshot, startRouterDashboardEventStream
 * @exports cycleRouterDashboardActiveSet, cycleRouterDashboardProbeMode
 * @exports clearRouterDashboardRequestLog, restartRouterDashboardDaemon
 * @exports toggleRouterDashboardProbePause, stopRouterDashboardClient
 * @exports renderRouterDashboard, normalizeRouterDashboardSnapshot
 * @exports parseRouterDashboardSseFrame, formatRouterDuration
 * @exports fetchRouterSets, createRouterSet, renameRouterSet, duplicateRouterSet
 * @exports deleteRouterSet, activateRouterSet, updateRouterSetModels
 * @exports addModelToRouterSet, removeModelFromRouterSet, reorderRouterSetModel
 *
 * @see ./router-daemon.js — daemon endpoints consumed by this screen
 * @see ./overlays.js — overlay factory that mounts this renderer
 * @see ./key-handler.js — dashboard key bindings
 */

import { existsSync, readFileSync } from 'node:fs'
import { displayWidth, padEndDisplay, sliceOverlayLines, tintOverlayLines } from './render-helpers.js'
import { ROUTER_DEFAULT_PORT, ROUTER_MAX_PORT, ROUTER_PID_PATH, ROUTER_PORT_PATH, getRouterPortRange } from './router-daemon.js'
import { themeColors } from './theme.js'
import { formatTokenTotalCompact } from './token-usage-reader.js'
import { sendUsageTelemetry } from './telemetry.js'

export const ROUTER_DASHBOARD_POLL_INTERVAL_MS = 2000
export const ROUTER_DASHBOARD_FETCH_TIMEOUT_MS = 1200
export const ROUTER_PROBE_MODE_CYCLE = ['eco', 'balanced', 'aggressive']

const ROUTER_DASHBOARD_EVENT_LIMIT = 80
const ROUTER_DASHBOARD_REQUEST_LIMIT = 30

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function safeString(value, fallback = '—') {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

function compactText(value, width) {
  const text = safeString(value, '')
  if (displayWidth(text) <= width) return padEndDisplay(text, width)
  const plain = text.replace(/\s+/g, ' ')
  let out = ''
  for (const char of plain) {
    if (displayWidth(`${out}${char}…`) > width) break
    out += char
  }
  return padEndDisplay(`${out}…`, width)
}

function readNumberFile(path) {
  try {
    const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function makeTimeoutController(ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  }
}

async function fetchJson(url, options = {}) {
  const {
    method = 'GET',
    body = null,
    fetchFn = globalThis.fetch,
    timeoutMs = ROUTER_DASHBOARD_FETCH_TIMEOUT_MS,
  } = options
  if (typeof fetchFn !== 'function') {
    return { ok: false, status: 0, data: null, error: 'fetch is not available in this Node runtime' }
  }

  const timeout = makeTimeoutController(timeoutMs)
  try {
    const response = await fetchFn(url, {
      method,
      body,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      signal: timeout.signal,
    })
    const raw = await response.text()
    let data = {}
    try {
      data = raw.trim() ? JSON.parse(raw) : {}
    } catch {
      return { ok: false, status: response.status, data: null, error: `Malformed JSON from ${url}` }
    }
    if (!response.ok) {
      const message = data?.error?.message || data?.error?.code || `HTTP ${response.status}`
      return { ok: false, status: response.status, data, error: message }
    }
    return { ok: true, status: response.status, data, error: null }
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'request timed out' : (error?.message || String(error))
    return { ok: false, status: 0, data: null, error: message }
  } finally {
    timeout.clear()
  }
}

function readDaemonFiles() {
  const recordedPort = readNumberFile(ROUTER_PORT_PATH)
  const recordedPid = readNumberFile(ROUTER_PID_PATH)
  return {
    port: recordedPort,
    pid: recordedPid,
    pidAlive: recordedPid ? isProcessAlive(recordedPid) : false,
    hasPidFile: existsSync(ROUTER_PID_PATH),
    hasPortFile: existsSync(ROUTER_PORT_PATH),
  }
}

function buildPortCandidates(state) {
  const ports = []
  const currentPort = Number.parseInt(String(state.routerDashboardPort || ''), 10)
  const baseUrlMatch = typeof state.routerDashboardBaseUrl === 'string'
    ? state.routerDashboardBaseUrl.match(/:(\d+)$/)
    : null
  const baseUrlPort = baseUrlMatch ? Number.parseInt(baseUrlMatch[1], 10) : null
  const filePort = readNumberFile(ROUTER_PORT_PATH)
  const { defaultPort, maxPort } = getRouterPortRange()
  for (const port of [baseUrlPort, currentPort, filePort, defaultPort]) {
    if (Number.isInteger(port) && port > 0 && !ports.includes(port)) ports.push(port)
  }
  for (let port = defaultPort; port <= maxPort; port += 1) {
    if (!ports.includes(port)) ports.push(port)
  }
  return ports
}

async function discoverRouterDashboard(state, fetchFn = globalThis.fetch) {
  let lastError = null
  for (const port of buildPortCandidates(state)) {
    const baseUrl = `http://127.0.0.1:${port}`
    const health = await fetchJson(`${baseUrl}/health`, { fetchFn })
    if (health.ok) return { baseUrl, port, health: health.data, error: null }
    lastError = health.error
  }
  const files = readDaemonFiles()
  return {
    baseUrl: null,
    port: files.port,
    health: {
      ok: false,
      running: false,
      pid: files.pid,
      port: files.port,
      stalePid: files.pid && !files.pidAlive ? files.pid : null,
    },
    error: lastError || 'Router daemon is not reachable',
  }
}

function normalizeTokens(tokens) {
  const today = isRecord(tokens?.today) ? tokens.today : {}
  const allTime = isRecord(tokens?.all_time) ? tokens.all_time : {}
  return {
    today: {
      total_tokens: toFiniteNumber(today.total_tokens, 0),
      prompt_tokens: toFiniteNumber(today.prompt_tokens, 0),
      completion_tokens: toFiniteNumber(today.completion_tokens, 0),
      requests: toFiniteNumber(today.requests, 0),
      by_model: isRecord(today.by_model) ? today.by_model : {},
    },
    all_time: {
      total_tokens: toFiniteNumber(allTime.total_tokens, 0),
      prompt_tokens: toFiniteNumber(allTime.prompt_tokens, 0),
      completion_tokens: toFiniteNumber(allTime.completion_tokens, 0),
      requests: toFiniteNumber(allTime.requests, 0),
      first_tracked: safeString(allTime.first_tracked, null),
    },
  }
}

function normalizeModelHealth(entry, index) {
  const model = isRecord(entry) ? entry : {}
  return {
    priority: toFiniteNumber(model.priority, index + 1),
    provider: safeString(model.provider, 'unknown'),
    model: safeString(model.model, 'unknown'),
    key: safeString(model.key, `${safeString(model.provider, 'unknown')}/${safeString(model.model, 'unknown')}`),
    state: safeString(model.state, 'UNKNOWN').toUpperCase(),
    score: toFiniteNumber(model.score, null),
    last_latency_ms: toFiniteNumber(model.last_latency_ms, null),
    uptime: toFiniteNumber(model.uptime, null),
    last_error: safeString(model.last_error, null),
  }
}

function normalizeRequestEntry(entry) {
  const item = isRecord(entry) ? entry : {}
  return {
    at: safeString(item.at, new Date().toISOString()),
    request_id: safeString(item.request_id, ''),
    model: safeString(item.model, '—'),
    status: item.status ?? '—',
    latency_ms: toFiniteNumber(item.latency_ms, null),
    tokens: toFiniteNumber(item.tokens, 0),
    failover: item.failover === true,
    stream: item.stream === true,
    error: safeString(item.error, null),
  }
}

export function normalizeRouterDashboardSnapshot(healthPayload, statsPayload) {
  const health = isRecord(healthPayload) ? healthPayload : {}
  const stats = isRecord(statsPayload) ? statsPayload : {}
  const merged = { ...health, ...stats }
  const models = Array.isArray(stats.models) ? stats.models.map(normalizeModelHealth) : []
  const requestLog = Array.isArray(stats.requestLog) ? stats.requestLog.map(normalizeRequestEntry) : []

  return {
    ok: merged.ok === true,
    pid: toFiniteNumber(merged.pid, null),
    port: toFiniteNumber(merged.port, null),
    enabled: merged.enabled === true,
    activeSet: safeString(merged.activeSet, '—'),
    activeModelCount: toFiniteNumber(merged.activeModelCount, models.length),
    setCount: toFiniteNumber(merged.setCount, 0),
    uptimeSeconds: toFiniteNumber(merged.uptimeSeconds, 0),
    requestsRouted: toFiniteNumber(merged.requestsRouted, 0),
    inFlight: toFiniteNumber(merged.inFlight, 0),
    shuttingDown: merged.shuttingDown === true,
    probeMode: safeString(merged.probeMode, 'unknown'),
    lastProbeAt: safeString(merged.lastProbeAt, null),
    crashRecovered: toFiniteNumber(merged.crashRecovered, 0),
    configPath: safeString(merged.configPath, ''),
    tokenStatsPath: safeString(merged.tokenStatsPath, ''),
    logPath: safeString(merged.logPath, ''),
    stalePid: toFiniteNumber(merged.stalePid, null),
    tokens: normalizeTokens(stats.tokens),
    models,
    requestLog,
  }
}

export function formatRouterDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function formatAge(iso) {
  if (!iso) return 'never'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'unknown'
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  return `${formatRouterDuration(seconds)} ago`
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value * 100)}%`
}

function modelStateBadge(state) {
  const label = safeString(state, 'UNKNOWN').toUpperCase()
  if (label === 'CLOSED') return themeColors.success('● CLOSED')
  if (label === 'HALF_OPEN') return themeColors.warning('◐ HALF')
  if (label === 'OPEN') return themeColors.error('○ OPEN')
  if (label === 'AUTH_ERROR') return themeColors.error('⚠ AUTH')
  if (label === 'STALE') return themeColors.dim('💀 STALE')
  if (label === 'UNSUPPORTED') return themeColors.dim('× UNSUP')
  return themeColors.dim(`? ${label}`)
}

function statusBadge(status, snapshot) {
  if (status === 'ready') return themeColors.successBold('● RUNNING')
  if (status === 'partial') return themeColors.warningBold('◐ PARTIAL')
  if (status === 'loading') return themeColors.warning('◌ LOADING')
  if (status === 'stale' || snapshot.stalePid) return themeColors.errorBold('○ STALE PID')
  if (status === 'malformed') return themeColors.errorBold('○ BAD JSON')
  if (status === 'stopped') return themeColors.dim('○ STOPPED')
  return themeColors.error('○ UNREACHABLE')
}

function setDashboardNotice(state, type, message, ttlMs = 3500) {
  state.routerDashboardNotice = { type, message, at: Date.now() }
  if (state.routerDashboardNoticeTimer) clearTimeout(state.routerDashboardNoticeTimer)
  state.routerDashboardNoticeTimer = setTimeout(() => {
    if (state.routerDashboardNotice?.message === message) state.routerDashboardNotice = null
  }, ttlMs)
  state.routerDashboardNoticeTimer.unref?.()
}

export function parseRouterDashboardSseFrame(frame) {
  const lines = String(frame || '').split(/\r?\n/)
  let event = 'message'
  const dataLines = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim() || 'message'
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  const rawData = dataLines.join('\n')
  let data = null
  if (rawData) {
    try {
      data = JSON.parse(rawData)
    } catch {
      data = rawData
    }
  }
  return { event, data }
}

export function appendRouterDashboardEvent(state, event, data) {
  if (!Array.isArray(state.routerDashboardEvents)) state.routerDashboardEvents = []
  const entry = { event, data, at: new Date().toISOString() }
  state.routerDashboardEvents.unshift(entry)
  while (state.routerDashboardEvents.length > ROUTER_DASHBOARD_EVENT_LIMIT) state.routerDashboardEvents.pop()

  if (event === 'request') {
    if (!Array.isArray(state.routerDashboardLiveRequests)) state.routerDashboardLiveRequests = []
    state.routerDashboardLiveRequests.unshift(normalizeRequestEntry({ ...(isRecord(data) ? data : {}), at: entry.at }))
    while (state.routerDashboardLiveRequests.length > ROUTER_DASHBOARD_REQUEST_LIMIT) state.routerDashboardLiveRequests.pop()
  }
}

export async function refreshRouterDashboardSnapshot(state, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  if (!state.routerDashboardOpen && !options.force) return null
  state.routerDashboardLastRefreshStartedAt = Date.now()
  if (!state.routerDashboardStatus || state.routerDashboardStatus === 'idle') {
    state.routerDashboardStatus = 'loading'
  }

  let discovery
  try {
    discovery = await discoverRouterDashboard(state, fetchFn)
  } catch (err) {
    // 📖 Guard: if discovery itself throws (e.g. fetchFn not callable), degrade gracefully
    state.routerDashboardStatus = 'unreachable'
    state.routerDashboardError = err?.message || 'Discovery failed unexpectedly'
    state.routerDashboardLastUpdatedAt = Date.now()
    return normalizeRouterDashboardSnapshot(null, null)
  }
  if (!discovery.baseUrl) {
    state.routerDashboardBaseUrl = null
    state.routerDashboardPort = discovery.port
    state.routerDashboardHealth = discovery.health
    state.routerDashboardStats = null
    const files = readDaemonFiles()
    state.routerDashboardStatus = discovery.health?.stalePid
      ? 'stale'
      : files.hasPidFile || files.hasPortFile
        ? 'unreachable'
        : 'stopped'
    state.routerDashboardError = discovery.error
    state.routerDashboardLastUpdatedAt = Date.now()
    stopRouterDashboardEventStream(state)
    return normalizeRouterDashboardSnapshot(state.routerDashboardHealth, null)
  }

  state.routerDashboardBaseUrl = discovery.baseUrl
  state.routerDashboardPort = discovery.port
  state.routerDashboardHealth = discovery.health
  const stats = await fetchJson(`${discovery.baseUrl}/stats`, { fetchFn })
  if (!stats.ok) {
    state.routerDashboardStats = null
    state.routerDashboardStatus = stats.error?.includes('Malformed JSON') ? 'malformed' : 'partial'
    state.routerDashboardError = stats.error
    state.routerDashboardLastUpdatedAt = Date.now()
    startRouterDashboardEventStream(state, { fetchFn })
    return normalizeRouterDashboardSnapshot(state.routerDashboardHealth, null)
  }

  state.routerDashboardStats = stats.data
  state.routerDashboardStatus = 'ready'
  state.routerDashboardError = null
  state.routerDashboardLastUpdatedAt = Date.now()
  startRouterDashboardEventStream(state, { fetchFn })
  return normalizeRouterDashboardSnapshot(state.routerDashboardHealth, state.routerDashboardStats)
}

export function startRouterDashboardPolling(state, options = {}) {
  if (state.routerDashboardPollTimer) return
  const fetchFn = options.fetchFn || globalThis.fetch
  void refreshRouterDashboardSnapshot(state, { fetchFn, force: true })
  state.routerDashboardPollTimer = setInterval(() => {
    void refreshRouterDashboardSnapshot(state, { fetchFn, force: true })
  }, ROUTER_DASHBOARD_POLL_INTERVAL_MS)
  state.routerDashboardPollTimer.unref?.()
}

export function stopRouterDashboardEventStream(state) {
  if (state.routerDashboardEventAbort) {
    try { state.routerDashboardEventAbort.abort() } catch {}
  }
  state.routerDashboardEventAbort = null
  if (state.routerDashboardEventStatus === 'connected' || state.routerDashboardEventStatus === 'connecting') {
    state.routerDashboardEventStatus = 'idle'
  }
}

export function stopRouterDashboardClient(state) {
  if (state.routerDashboardPollTimer) clearInterval(state.routerDashboardPollTimer)
  state.routerDashboardPollTimer = null
  stopRouterDashboardEventStream(state)
  if (state.routerDashboardNoticeTimer) clearTimeout(state.routerDashboardNoticeTimer)
  state.routerDashboardNoticeTimer = null
}

export function startRouterDashboardEventStream(state, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  if (!state.routerDashboardOpen) return
  if (!state.routerDashboardBaseUrl || typeof fetchFn !== 'function') return
  if (state.routerDashboardEventAbort) return

  const controller = new AbortController()
  state.routerDashboardEventAbort = controller
  state.routerDashboardEventStatus = 'connecting'
  state.routerDashboardEventError = null

  void (async () => {
    try {
      const response = await fetchFn(`${state.routerDashboardBaseUrl}/stream/events`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`SSE HTTP ${response.status}`)
      if (!response.body || typeof response.body.getReader !== 'function') throw new Error('SSE body is not readable')
      state.routerDashboardEventStatus = 'connected'
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!controller.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let frameEnd = buffer.indexOf('\n\n')
        while (frameEnd >= 0) {
          const frame = buffer.slice(0, frameEnd)
          buffer = buffer.slice(frameEnd + 2)
          const parsed = parseRouterDashboardSseFrame(frame)
          appendRouterDashboardEvent(state, parsed.event, parsed.data)
          frameEnd = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        state.routerDashboardEventStatus = 'offline'
        state.routerDashboardEventError = error?.message || String(error)
      }
    } finally {
      if (state.routerDashboardEventAbort === controller) state.routerDashboardEventAbort = null
    }
  })()
}

export function openRouterDashboardOverlay(state) {
  state.routerDashboardOpen = true
  state.routerDashboardScrollOffset = 0
  state.routerDashboardStatus = state.routerDashboardStatus || 'loading'
  startRouterDashboardPolling(state)
  // 📖 Fire app_router_install on first Shift+R dashboard open for upgrade-path users
  if (!state.routerDashboardEverOpened && state.config?.router) {
    state.routerDashboardEverOpened = true
    void sendUsageTelemetry(state.config, {}, {
      event: 'app_router_install',
      mode: 'dashboard',
      properties: { router_version: '0.4.0', trigger: 'upgrade_path' },
    })
  }
}

export function closeRouterDashboardOverlay(state) {
  state.routerDashboardOpen = false
  state.routerDashboardScrollOffset = 0
  stopRouterDashboardClient(state)
}

export function closeRouterSetsManagerOverlay(state) {
  state.setsOpen = false
  state.setsScrollOffset = 0
  state.setsEditMode = null
  state.setsEditBuffer = ''
  state.setsAddPositionPickerOpen = false
}

export async function cycleRouterDashboardActiveSet(state, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) {
    setDashboardNotice(state, 'error', 'Router daemon is not reachable; cannot switch sets.')
    return
  }
  const response = await fetchJson(`${baseUrl}/sets`, { fetchFn })
  if (!response.ok || !isRecord(response.data?.sets)) {
    setDashboardNotice(state, 'error', `Could not load router sets: ${response.error || 'unexpected payload'}`)
    return
  }
  const setNames = Object.keys(response.data.sets)
  if (setNames.length <= 1) {
    setDashboardNotice(state, 'info', 'Only one router set exists right now.')
    return
  }
  const active = safeString(response.data.activeSet, setNames[0])
  const activeIdx = Math.max(0, setNames.indexOf(active))
  const nextName = setNames[(activeIdx + 1) % setNames.length]
  const activate = await fetchJson(`${baseUrl}/sets/${encodeURIComponent(nextName)}/activate`, {
    method: 'POST',
    fetchFn,
  })
  if (!activate.ok) {
    setDashboardNotice(state, 'error', `Could not activate ${nextName}: ${activate.error}`)
    return
  }
  setDashboardNotice(state, 'success', `Active router set: ${nextName}`)
  await refreshRouterDashboardSnapshot(state, { fetchFn, force: true })
}

export async function cycleRouterDashboardProbeMode(state, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) {
    setDashboardNotice(state, 'error', 'Router daemon is not reachable; cannot change probe mode.')
    return
  }
  const snapshot = normalizeRouterDashboardSnapshot(state.routerDashboardHealth, state.routerDashboardStats)
  const currentIndex = ROUTER_PROBE_MODE_CYCLE.indexOf(snapshot.probeMode)
  const nextMode = ROUTER_PROBE_MODE_CYCLE[(currentIndex >= 0 ? currentIndex + 1 : 0) % ROUTER_PROBE_MODE_CYCLE.length]
  const response = await fetchJson(`${baseUrl}/daemon/probe-mode`, {
    method: 'POST',
    body: JSON.stringify({ probeMode: nextMode }),
    fetchFn,
  })
  if (!response.ok) {
    setDashboardNotice(state, 'error', `Probe mode change failed: ${response.error}`)
    return
  }
  setDashboardNotice(state, 'success', `Probe mode: ${nextMode}`)
  await refreshRouterDashboardSnapshot(state, { fetchFn, force: true })
}

export function clearRouterDashboardRequestLog(state) {
  state.routerDashboardClearedAt = Date.now()
  state.routerDashboardLiveRequests = []
  state.routerDashboardEvents = []
  setDashboardNotice(state, 'success', 'Local dashboard request log cleared.')
}

export function restartRouterDashboardDaemon(state) {
  setDashboardNotice(state, 'info', 'Restart is reserved for Phase 7 service-manager support.')
}

export function toggleRouterDashboardProbePause(state) {
  setDashboardNotice(state, 'info', 'Probe pause/resume needs backend support and remains disabled for now.')
}

// ── Set Manager helpers (Phase 4) ──────────────────────────────────────────────

const SETS_FETCH_INTERVAL_MS = 5000

function isSetsDataStale(lastFetchAt) {
  return Date.now() - lastFetchAt > SETS_FETCH_INTERVAL_MS
}

export async function fetchRouterSets(state, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) {
    return { ok: false, error: 'Daemon not reachable', sets: null }
  }
  const result = await fetchJson(`${baseUrl}/sets`, { fetchFn })
  if (!result.ok) return { ok: false, error: result.error, sets: null }
  const payload = result.data
  if (!isRecord(payload) || !isRecord(payload.sets)) {
    return { ok: false, error: 'Unexpected /sets payload', sets: null }
  }
  state.setsData = payload
  state.setsLastFetchAt = Date.now()
  return { ok: true, error: null, sets: payload }
}

export async function createRouterSet(state, name, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const result = await fetchJson(`${baseUrl}/sets`, {
    method: 'POST',
    body: JSON.stringify({ name, models: [] }),
    fetchFn,
  })
  if (!result.ok) return { ok: false, error: result.error }
  await fetchRouterSets(state, { fetchFn })
  return { ok: true }
}

export async function renameRouterSet(state, oldName, newName, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const result = await fetchJson(`${baseUrl}/sets/${encodeURIComponent(oldName)}`, {
    method: 'PUT',
    body: JSON.stringify({ name: newName }),
    fetchFn,
  })
  if (!result.ok) return { ok: false, error: result.error }
  await fetchRouterSets(state, { fetchFn })
  return { ok: true }
}

export async function duplicateRouterSet(state, sourceName, newName, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const sets = state.setsData?.sets
  if (!sets || !sets[sourceName]) return { ok: false, error: 'Source set not found' }
  const models = sets[sourceName].models || []
  const result = await fetchJson(`${baseUrl}/sets`, {
    method: 'POST',
    body: JSON.stringify({ name: newName, models }),
    fetchFn,
  })
  if (!result.ok) return { ok: false, error: result.error }
  await fetchRouterSets(state, { fetchFn })
  return { ok: true }
}

export async function deleteRouterSet(state, name, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const result = await fetchJson(`${baseUrl}/sets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    fetchFn,
  })
  if (!result.ok) return { ok: false, error: result.error }
  await fetchRouterSets(state, { fetchFn })
  return { ok: true }
}

export async function activateRouterSet(state, name, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const result = await fetchJson(`${baseUrl}/sets/${encodeURIComponent(name)}/activate`, {
    method: 'POST',
    fetchFn,
  })
  if (!result.ok) return { ok: false, error: result.error }
  await fetchRouterSets(state, { fetchFn })
  return { ok: true }
}

export async function updateRouterSetModels(state, setName, models, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const result = await fetchJson(`${baseUrl}/sets/${encodeURIComponent(setName)}`, {
    method: 'PUT',
    body: JSON.stringify({ models }),
    fetchFn,
  })
  if (!result.ok) return { ok: false, error: result.error }
  await fetchRouterSets(state, { fetchFn })
  return { ok: true }
}

export async function addModelToRouterSet(state, setName, provider, model, priority, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const sets = state.setsData?.sets
  if (!sets || !sets[setName]) return { ok: false, error: 'Set not found' }
  const currentModels = sets[setName].models || []
  const modelEntry = { provider, model, priority: Number(priority) || currentModels.length + 1 }
  const result = await updateRouterSetModels(state, setName, [...currentModels, modelEntry], { fetchFn })
  return result
}

export async function removeModelFromRouterSet(state, setName, provider, model, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const sets = state.setsData?.sets
  if (!sets || !sets[setName]) return { ok: false, error: 'Set not found' }
  const currentModels = (sets[setName].models || []).filter(
    (m) => !(m.provider === provider && m.model === model)
  )
  return updateRouterSetModels(state, setName, currentModels, { fetchFn })
}

export async function reorderRouterSetModel(state, setName, provider, model, direction, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch
  const baseUrl = state.routerDashboardBaseUrl
  if (!baseUrl) return { ok: false, error: 'Daemon not reachable' }
  const sets = state.setsData?.sets
  if (!sets || !sets[setName]) return { ok: false, error: 'Set not found' }
  const currentModels = [...(sets[setName].models || [])]
  const idx = currentModels.findIndex((m) => m.provider === provider && m.model === model)
  if (idx < 0) return { ok: false, error: 'Model not in set' }
  const newIdx = direction === 'up' ? idx - 1 : idx + 1
  if (newIdx < 0 || newIdx >= currentModels.length) return { ok: false, error: 'Already at edge' }
  const [moved] = currentModels.splice(idx, 1)
  currentModels.splice(newIdx, 0, moved)
  for (let i = 0; i < currentModels.length; i++) {
    currentModels[i] = { ...currentModels[i], priority: i + 1 }
  }
  return updateRouterSetModels(state, setName, currentModels, { fetchFn })
}

function requestLogRows(state, snapshot) {
  const clearedAt = Number(state.routerDashboardClearedAt || 0)
  const candidates = [
    ...(Array.isArray(state.routerDashboardLiveRequests) ? state.routerDashboardLiveRequests : []),
    ...snapshot.requestLog,
  ]
  const seen = new Set()
  return candidates
    .filter((entry) => {
      const at = Date.parse(entry.at)
      return !Number.isFinite(at) || at >= clearedAt
    })
    .filter((entry) => {
      const key = entry.request_id || `${entry.at}:${entry.model}:${entry.status}:${entry.latency_ms}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 10)
}

function topTokenModel(tokens) {
  const byModel = tokens.today.by_model
  let bestKey = null
  let bestTotal = 0
  for (const [key, value] of Object.entries(byModel || {})) {
    const total = toFiniteNumber(isRecord(value) ? value.total : value, 0)
    if (total > bestTotal) {
      bestKey = key
      bestTotal = total
    }
  }
  return bestKey ? `${bestKey} (${formatTokenTotalCompact(bestTotal)})` : '—'
}

function renderNotice(notice) {
  if (!notice?.message) return null
  const color = notice.type === 'error'
    ? themeColors.errorBold
    : notice.type === 'success'
      ? themeColors.successBold
      : themeColors.warningBold
  return `  ${color(notice.message)}`
}

export function renderRouterDashboard(state, deps = {}) {
  const LOCAL_VERSION = deps.LOCAL_VERSION || ''
  const EL = '\x1b[K'
  const lines = []
  const snapshot = normalizeRouterDashboardSnapshot(state.routerDashboardHealth, state.routerDashboardStats)
  const status = state.routerDashboardStatus || 'idle'
  const width = Math.max(80, state.terminalCols || 80)
  const separator = themeColors.dim('─'.repeat(Math.max(20, width - 6)))
  const requestRows = requestLogRows(state, snapshot)
  const eventStatus = state.routerDashboardEventStatus || 'idle'
  const updatedAt = state.routerDashboardLastUpdatedAt
    ? new Date(state.routerDashboardLastUpdatedAt).toLocaleTimeString()
    : 'never'

  lines.push(`  ${themeColors.accent('🚀')} ${themeColors.accentBold('free-coding-models')} ${themeColors.dim(LOCAL_VERSION ? `v${LOCAL_VERSION}` : '')}`)
  lines.push(`  ${themeColors.textBold('🔀 FCM Router Dashboard')}  ${themeColors.dim('Shift+R from main table')}`)
  lines.push('')
  lines.push(`  Daemon: ${statusBadge(status, snapshot)}  ${themeColors.dim('Port:')} ${themeColors.info(String(snapshot.port || state.routerDashboardPort || '—'))}  ${themeColors.dim('PID:')} ${snapshot.pid || '—'}  ${themeColors.dim('SSE:')} ${eventStatus}`)
  lines.push(`  Set: ${themeColors.textBold(snapshot.activeSet)}  ${themeColors.dim('Models:')} ${snapshot.activeModelCount}  ${themeColors.dim('Uptime:')} ${formatRouterDuration(snapshot.uptimeSeconds)}  ${themeColors.dim('Requests:')} ${snapshot.requestsRouted}  ${themeColors.dim('In flight:')} ${snapshot.inFlight}`)
  lines.push(`  Probes: ${themeColors.info(snapshot.probeMode)}  ${themeColors.dim('Last probe:')} ${formatAge(snapshot.lastProbeAt)}  ${themeColors.dim('Last refresh:')} ${updatedAt}`)
  if (state.routerDashboardError) lines.push(`  ${themeColors.error(`Dashboard note: ${state.routerDashboardError}`)}`)
  if (state.routerDashboardEventError) lines.push(`  ${themeColors.warning(`Event stream: ${state.routerDashboardEventError}`)}`)
  const notice = renderNotice(state.routerDashboardNotice)
  if (notice) lines.push(notice)
  if (snapshot.setCount === 0) {
    lines.push(`  ${themeColors.warningBold('⚠ No router sets found. Press Y to install providers into FCM Router, then restart the daemon.')}`)
  }
  lines.push(`  ${separator}`)
  lines.push('')

  lines.push(`  ${themeColors.textBold('Model Health / Circuit Breakers')}`)
  if (snapshot.models.length === 0) {
    lines.push(`  ${themeColors.dim('No model health rows available yet. Start the daemon or wait for /stats to answer.')}`)
  } else {
    const header = `  ${padEndDisplay('#', 4)} ${padEndDisplay('Provider', 12)} ${padEndDisplay('Model', 30)} ${padEndDisplay('State', 12)} ${padEndDisplay('P95', 8)} ${padEndDisplay('Up', 5)} Score`
    lines.push(themeColors.dim(header))
    for (const model of snapshot.models.slice(0, 12)) {
      const latency = Number.isFinite(model.last_latency_ms) ? `${Math.round(model.last_latency_ms)}ms` : '—'
      const score = Number.isFinite(model.score) ? model.score.toFixed(2) : '—'
      const errorSuffix = model.last_error ? themeColors.dim(`  ${compactText(model.last_error, 22).trimEnd()}`) : ''
      lines.push(
        `  ${padEndDisplay(String(model.priority), 4)} ` +
        `${compactText(model.provider, 12)} ` +
        `${compactText(model.model, 30)} ` +
        `${padEndDisplay(modelStateBadge(model.state), 12)} ` +
        `${padEndDisplay(latency, 8)} ` +
        `${padEndDisplay(formatPercent(model.uptime), 5)} ` +
        `${score}${errorSuffix}`
      )
    }
    if (snapshot.models.length > 12) lines.push(themeColors.dim(`  … ${snapshot.models.length - 12} more models in active set`))
  }

  lines.push('')
  lines.push(`  ${themeColors.textBold('Token Summary')}`)
  lines.push(`  Today: ${themeColors.info(formatTokenTotalCompact(snapshot.tokens.today.total_tokens))} tok  ${themeColors.dim('Requests:')} ${snapshot.tokens.today.requests}  ${themeColors.dim('Prompt/Completion:')} ${formatTokenTotalCompact(snapshot.tokens.today.prompt_tokens)} / ${formatTokenTotalCompact(snapshot.tokens.today.completion_tokens)}`)
  lines.push(`  All-time: ${themeColors.info(formatTokenTotalCompact(snapshot.tokens.all_time.total_tokens))} tok  ${themeColors.dim('Requests:')} ${snapshot.tokens.all_time.requests}  ${themeColors.dim('Top today:')} ${compactText(topTokenModel(snapshot.tokens), Math.max(18, width - 58)).trimEnd()}`)

  lines.push('')
  lines.push(`  ${themeColors.textBold('Live Request Log')}`)
  if (requestRows.length === 0) {
    lines.push(`  ${themeColors.dim('No routed requests in the local dashboard log yet.')}`)
  } else {
    const header = `  ${padEndDisplay('Time', 10)} ${padEndDisplay('Model', 34)} ${padEndDisplay('Status', 8)} ${padEndDisplay('Latency', 9)} ${padEndDisplay('Tokens', 9)} Detail`
    lines.push(themeColors.dim(header))
    for (const row of requestRows) {
      const atMs = Date.parse(row.at)
      const time = Number.isFinite(atMs) ? new Date(atMs).toLocaleTimeString() : '—'
      const statusText = String(row.status)
      const statusColor = statusText.startsWith('2') ? themeColors.success : statusText === 'ERR' ? themeColors.error : themeColors.warning
      const latency = Number.isFinite(row.latency_ms) ? `${Math.round(row.latency_ms)}ms` : '—'
      const detail = [
        row.failover ? 'failover' : '',
        row.stream ? 'stream' : '',
        row.error || '',
      ].filter(Boolean).join(', ') || '—'
      lines.push(
        `  ${padEndDisplay(time, 10)} ` +
        `${compactText(row.model, 34)} ` +
        `${padEndDisplay(statusColor(statusText), 8)} ` +
        `${padEndDisplay(latency, 9)} ` +
        `${padEndDisplay(formatTokenTotalCompact(row.tokens), 9)} ` +
        `${compactText(detail, Math.max(10, width - 78)).trimEnd()}`
      )
    }
  }

  lines.push('')
  const lastEvent = Array.isArray(state.routerDashboardEvents) && state.routerDashboardEvents[0]
    ? `${state.routerDashboardEvents[0].event} @ ${new Date(state.routerDashboardEvents[0].at).toLocaleTimeString()}`
    : 'none'
  lines.push(`  ${themeColors.dim(`Endpoint: ${state.routerDashboardBaseUrl || 'not connected'}  •  Last SSE event: ${lastEvent}`)}`)
  lines.push(`  ${themeColors.hotkey('S')} ${themeColors.dim('Switch set')}  ${themeColors.dim('•')}  ${themeColors.hotkey('I')} ${themeColors.dim('Probe mode')}  ${themeColors.dim('•')}  ${themeColors.hotkey('R')} ${themeColors.dim('Restart (Phase 7)')}  ${themeColors.dim('•')}  ${themeColors.hotkey('C')} ${themeColors.dim('Clear log')}  ${themeColors.dim('•')}  ${themeColors.hotkey('P')} ${themeColors.dim('Pause probes (disabled)')}  ${themeColors.dim('•')}  ${themeColors.hotkey('Esc')} ${themeColors.dim('Back')}`)

  const { visible, offset } = sliceOverlayLines(lines, state.routerDashboardScrollOffset || 0, state.terminalRows || 24)
  state.routerDashboardScrollOffset = offset
  const tinted = tintOverlayLines(visible, themeColors.overlayBgSettings, state.terminalCols || 80)
  return tinted.map((line) => line + EL).join('\n')
}
