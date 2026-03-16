#!/usr/bin/env node

/**
 * @file bin/fcm-proxy-daemon.js
 * @description Standalone headless FCM proxy daemon — runs independently of the TUI.
 *
 * 📖 This is the always-on background proxy server. It reads the user's config
 *    (~/.free-coding-models.json), builds the proxy topology (merged models × API keys),
 *    and starts a ProxyServer on a stable port with a stable token.
 *
 * 📖 When installed as a launchd LaunchAgent (macOS) or systemd user service (Linux),
 *    this daemon starts at login and persists across reboots, allowing Claude Code,
 *    Gemini CLI, OpenCode, and all other tools to access free models 24/7.
 *
 * 📖 Status file: ~/.free-coding-models/daemon.json
 *    Contains PID, port, token, version, model/account counts. The TUI reads this
 *    to detect a running daemon and delegate instead of starting an in-process proxy.
 *
 * 📖 Hot-reload: Watches ~/.free-coding-models.json for changes and reloads the
 *    proxy topology (accounts, models) without restarting the process.
 *
 * @see src/proxy-topology.js — shared topology builder
 * @see src/proxy-server.js — ProxyServer implementation
 * @see src/daemon-manager.js — install/uninstall/status management
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, watch } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// 📖 Resolve package.json for version info
const __dirname = fileURLToPath(new URL('.', import.meta.url))
let PKG_VERSION = 'unknown'
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  PKG_VERSION = pkg.version || 'unknown'
} catch { /* ignore */ }

// 📖 Config + data paths
const CONFIG_PATH = join(homedir(), '.free-coding-models.json')
const DATA_DIR = join(homedir(), '.free-coding-models')
const DAEMON_STATUS_FILE = join(DATA_DIR, 'daemon.json')
const LOG_PREFIX = '[fcm-daemon]'

// 📖 Default daemon port — high port unlikely to conflict
const DEFAULT_DAEMON_PORT = 18045

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`${LOG_PREFIX} ${new Date().toISOString()} ${msg}`)
}

function logError(msg) {
  console.error(`${LOG_PREFIX} ${new Date().toISOString()} ERROR: ${msg}`)
}

/**
 * 📖 Write daemon status file so TUI and tools can discover the running daemon.
 */
function writeDaemonStatus(info) {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { mode: 0o700, recursive: true })
  }
  writeFileSync(DAEMON_STATUS_FILE, JSON.stringify(info, null, 2), { mode: 0o600 })
}

/**
 * 📖 Remove daemon status file on shutdown.
 */
function removeDaemonStatus() {
  try {
    if (existsSync(DAEMON_STATUS_FILE)) unlinkSync(DAEMON_STATUS_FILE)
  } catch { /* best-effort */ }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting FCM Proxy Daemon v${PKG_VERSION} (PID: ${process.pid})`)

  // 📖 Dynamic imports — keep startup fast, avoid loading TUI-specific modules
  const { loadConfig, getProxySettings } = await import('../src/config.js')
  const { ProxyServer } = await import('../src/proxy-server.js')
  const { buildProxyTopologyFromConfig, buildMergedModelsForDaemon } = await import('../src/proxy-topology.js')
  const { sources } = await import('../sources.js')

  // 📖 Load config and build initial topology
  let fcmConfig = loadConfig()
  const proxySettings = getProxySettings(fcmConfig)

  if (!proxySettings.stableToken) {
    logError('No stableToken in proxy settings — run the TUI first to initialize config.')
    process.exit(1)
  }

  const port = proxySettings.preferredPort || DEFAULT_DAEMON_PORT
  const token = proxySettings.stableToken

  log(`Building merged model catalog...`)
  let mergedModels = await buildMergedModelsForDaemon()
  log(`Merged ${mergedModels.length} model groups`)

  let { accounts, proxyModels } = buildProxyTopologyFromConfig(fcmConfig, mergedModels, sources)

  if (accounts.length === 0) {
    logError('No API keys configured — daemon has no accounts to serve. Add keys via the TUI.')
    process.exit(1)
  }

  log(`Built proxy topology: ${accounts.length} accounts across ${Object.keys(proxyModels).length} models`)

  // 📖 Start the proxy server
  const proxy = new ProxyServer({
    port,
    accounts,
    proxyApiKey: token,
  })

  try {
    const { port: listeningPort } = await proxy.start()
    log(`Proxy listening on 127.0.0.1:${listeningPort}`)

    // 📖 Write status file for TUI discovery
    const statusInfo = {
      pid: process.pid,
      port: listeningPort,
      token,
      startedAt: new Date().toISOString(),
      version: PKG_VERSION,
      modelCount: Object.keys(proxyModels).length,
      accountCount: accounts.length,
    }
    writeDaemonStatus(statusInfo)
    log(`Status file written to ${DAEMON_STATUS_FILE}`)

    // 📖 Set up config file watcher for hot-reload
    let reloadTimeout = null
    const configWatcher = watch(CONFIG_PATH, () => {
      // 📖 Debounce 1s — config writes can trigger multiple fs events
      if (reloadTimeout) clearTimeout(reloadTimeout)
      reloadTimeout = setTimeout(async () => {
        try {
          log('Config file changed — reloading topology...')
          fcmConfig = loadConfig()
          mergedModels = await buildMergedModelsForDaemon()
          const newTopology = buildProxyTopologyFromConfig(fcmConfig, mergedModels, sources)

          if (newTopology.accounts.length === 0) {
            log('Warning: new topology has 0 accounts — keeping current topology')
            return
          }

          proxy.updateAccounts(newTopology.accounts)
          accounts = newTopology.accounts
          proxyModels = newTopology.proxyModels

          // 📖 Update status file
          writeDaemonStatus({
            ...statusInfo,
            modelCount: Object.keys(proxyModels).length,
            accountCount: accounts.length,
          })

          log(`Topology reloaded: ${accounts.length} accounts, ${Object.keys(proxyModels).length} models`)
        } catch (err) {
          logError(`Hot-reload failed: ${err.message}`)
        }
      }, 1000)
    })

    // 📖 Graceful shutdown
    const shutdown = async (signal) => {
      log(`Received ${signal} — shutting down...`)
      if (reloadTimeout) clearTimeout(reloadTimeout)
      configWatcher.close()
      try {
        await proxy.stop()
      } catch { /* best-effort */ }
      removeDaemonStatus()
      log('Daemon stopped cleanly.')
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('exit', () => removeDaemonStatus())

    // 📖 Keep the process alive
    log('Daemon ready. Waiting for requests...')

  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      logError(`Port ${port} is already in use. Another daemon may be running, or another process occupies this port.`)
      logError(`Change proxy.preferredPort in ~/.free-coding-models.json or stop the conflicting process.`)
      process.exit(2)
    }
    logError(`Failed to start proxy: ${err.message}`)
    removeDaemonStatus()
    process.exit(1)
  }
}

main().catch(err => {
  logError(`Fatal: ${err.message}`)
  removeDaemonStatus()
  process.exit(1)
})
