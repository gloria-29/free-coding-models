/**
 * @file src/daemon-manager.js
 * @description OS-level service management for the FCM proxy daemon.
 *
 * 📖 Handles install/uninstall/status/restart of the always-on background proxy:
 *    - macOS: launchd LaunchAgent (~/Library/LaunchAgents/com.fcm.proxy.plist)
 *    - Linux: systemd user service (~/.config/systemd/user/fcm-proxy.service)
 *    - Windows: gracefully unsupported (falls back to in-process proxy)
 *
 * 📖 The daemon manager reads/writes daemon.json for IPC between TUI and daemon.
 *    It never imports TUI-specific modules (chalk, render-table, etc.).
 *
 * @functions
 *   → getDaemonStatus() — read daemon.json, verify PID alive, health-check HTTP
 *   → isDaemonRunning() — quick boolean check
 *   → getDaemonInfo() — raw daemon.json contents
 *   → installDaemon() — write plist/service, load/enable via OS (blocked in dev)
 *   → uninstallDaemon() — unload/disable, delete plist/service
 *   → restartDaemon() — stop + start via OS service manager
 *   → stopDaemon() — send SIGTERM without removing the service
 *   → killDaemonProcess() — send SIGKILL (emergency)
 *   → getVersionMismatch() — detect daemon vs FCM version drift
 *   → getDaemonLogPath() — path to daemon stdout log
 *   → getPlatformSupport() — { supported: boolean, platform: string, reason?: string }
 *
 * @exports getDaemonStatus, isDaemonRunning, getDaemonInfo, installDaemon, uninstallDaemon, restartDaemon, stopDaemon, killDaemonProcess, getVersionMismatch, getDaemonLogPath, getPlatformSupport
 * @see bin/fcm-proxy-daemon.js — the actual daemon process
 * @see src/config.js — DAEMON_DATA_DIR for status file location
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

// 📖 Paths
const DATA_DIR = join(homedir(), '.free-coding-models')
const DAEMON_STATUS_FILE = join(DATA_DIR, 'daemon.json')

// 📖 macOS launchd paths
const LAUNCH_AGENT_LABEL = 'com.fcm.proxy'
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LAUNCH_AGENT_LABEL}.plist`)

// 📖 Linux systemd paths
const SYSTEMD_USER_DIR = join(homedir(), '.config', 'systemd', 'user')
const SERVICE_NAME = 'fcm-proxy'
const SERVICE_PATH = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`)

// 📖 Log paths
const DAEMON_STDOUT_LOG = join(DATA_DIR, 'daemon-stdout.log')
const DAEMON_STDERR_LOG = join(DATA_DIR, 'daemon-stderr.log')

// ─── Platform detection ──────────────────────────────────────────────────────

/**
 * 📖 Check if the current platform supports daemon installation.
 * @returns {{ supported: boolean, platform: 'macos'|'linux'|'unsupported', reason?: string }}
 */
export function getPlatformSupport() {
  if (process.platform === 'darwin') return { supported: true, platform: 'macos' }
  if (process.platform === 'linux') return { supported: true, platform: 'linux' }
  return { supported: false, platform: 'unsupported', reason: `Platform '${process.platform}' is not supported for daemon mode. Use in-process proxy instead.` }
}

// ─── Resolve daemon script path ──────────────────────────────────────────────

/**
 * 📖 Get absolute path to the fcm-proxy-daemon.js script.
 * 📖 Works for both npm global installs and local development.
 */
function getDaemonScriptPath() {
  const thisFile = fileURLToPath(import.meta.url)
  return join(dirname(thisFile), '..', 'bin', 'fcm-proxy-daemon.js')
}

/**
 * 📖 Detect if we're running from a local dev checkout (not a global npm install).
 * 📖 A global npm install lives in a node_modules path. A dev checkout has a .git dir.
 * 📖 We block daemon install from dev to avoid hardcoding repo-local paths in launchd/systemd.
 */
function isDevEnvironment() {
  const thisFile = fileURLToPath(import.meta.url)
  const projectRoot = join(dirname(thisFile), '..')
  // 📖 If there's a .git directory at project root, it's a dev checkout
  return existsSync(join(projectRoot, '.git'))
}

/**
 * 📖 Get absolute path to node binary.
 */
function getNodePath() {
  return process.execPath
}

// ─── Daemon status ───────────────────────────────────────────────────────────

/**
 * 📖 Read the raw daemon.json status file.
 * @returns {object|null} parsed daemon.json or null if not found
 */
export function getDaemonInfo() {
  try {
    if (!existsSync(DAEMON_STATUS_FILE)) return null
    return JSON.parse(readFileSync(DAEMON_STATUS_FILE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 📖 Check if a PID is alive using signal 0.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // 📖 ESRCH = no such process, EPERM = exists but different user
    return err.code === 'EPERM'
  }
}

/**
 * 📖 HTTP health check against the daemon's /v1/health endpoint.
 * @param {number} port
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ ok: boolean, data?: object }>}
 */
function healthCheck(port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/v1/health`, { timeout: timeoutMs }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString())
          resolve({ ok: res.statusCode === 200, data })
        } catch {
          resolve({ ok: false })
        }
      })
    })
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
  })
}

/**
 * 📖 Get comprehensive daemon status.
 * @returns {Promise<{ status: 'running'|'stopped'|'stale'|'unhealthy'|'not-installed', info?: object, health?: object }>}
 */
export async function getDaemonStatus() {
  const info = getDaemonInfo()

  if (!info) {
    // 📖 Check if service files exist (installed but daemon.json missing)
    const serviceInstalled = existsSync(PLIST_PATH) || existsSync(SERVICE_PATH)
    return { status: serviceInstalled ? 'stopped' : 'not-installed' }
  }

  // 📖 Verify PID is alive
  if (!isPidAlive(info.pid)) {
    // 📖 Stale daemon.json — daemon crashed without cleanup
    try { unlinkSync(DAEMON_STATUS_FILE) } catch { /* ignore */ }
    return { status: 'stale', info }
  }

  // 📖 PID alive — health check the HTTP endpoint
  const health = await healthCheck(info.port)
  if (!health.ok) {
    return { status: 'unhealthy', info, health }
  }

  return { status: 'running', info, health }
}

/**
 * 📖 Quick boolean check if daemon is running and healthy.
 * @returns {Promise<boolean>}
 */
export async function isDaemonRunning() {
  const { status } = await getDaemonStatus()
  return status === 'running'
}

// ─── Install daemon ──────────────────────────────────────────────────────────

/**
 * 📖 Install and start the daemon as an OS background service.
 * 📖 Blocked in dev environments to avoid hardcoding repo-local paths
 *    in launchd/systemd service files. Use `pnpm start` + in-process proxy for dev.
 * @returns {{ success: boolean, error?: string }}
 */
export function installDaemon() {
  const platform = getPlatformSupport()
  if (!platform.supported) {
    return { success: false, error: platform.reason }
  }

  // 📖 Block daemon install from dev checkouts — the plist/service would
  //    hardcode paths to your local repo, which breaks on npm update.
  if (isDevEnvironment()) {
    return { success: false, error: 'Cannot install daemon from a dev checkout (has .git). Install free-coding-models globally via npm/pnpm first.' }
  }

  const nodePath = getNodePath()
  const daemonScript = getDaemonScriptPath()

  if (!existsSync(daemonScript)) {
    return { success: false, error: `Daemon script not found at ${daemonScript}` }
  }

  // 📖 Ensure data directory exists for logs
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { mode: 0o700, recursive: true })
  }

  try {
    if (platform.platform === 'macos') {
      return installMacOS(nodePath, daemonScript)
    } else {
      return installLinux(nodePath, daemonScript)
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

/**
 * 📖 macOS: Write LaunchAgent plist and load it.
 */
function installMacOS(nodePath, daemonScript) {
  // 📖 Ensure LaunchAgents directory exists
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true })
  }

  // 📖 Unload existing agent if any (ignore errors)
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' })
  } catch { /* ignore */ }

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${daemonScript}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DAEMON_STDOUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_STDERR_LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}</string>
  </dict>
</dict>
</plist>
`

  writeFileSync(PLIST_PATH, plistContent)
  execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'pipe' })

  return { success: true }
}

/**
 * 📖 Linux: Write systemd user service and enable/start it.
 */
function installLinux(nodePath, daemonScript) {
  if (!existsSync(SYSTEMD_USER_DIR)) {
    mkdirSync(SYSTEMD_USER_DIR, { recursive: true })
  }

  const serviceContent = `[Unit]
Description=FCM Proxy Daemon — Always-on model rotation proxy
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${daemonScript}
Restart=always
RestartSec=5
Environment=HOME=${homedir()}
Environment=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}
StandardOutput=append:${DAEMON_STDOUT_LOG}
StandardError=append:${DAEMON_STDERR_LOG}

[Install]
WantedBy=default.target
`

  writeFileSync(SERVICE_PATH, serviceContent)
  execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
  execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'pipe' })
  execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'pipe' })

  // 📖 Enable lingering so service survives logout
  try {
    execSync(`loginctl enable-linger ${process.env.USER || ''}`, { stdio: 'pipe' })
  } catch { /* non-fatal — might need sudo */ }

  return { success: true }
}

// ─── Uninstall daemon ────────────────────────────────────────────────────────

/**
 * 📖 Stop and remove the daemon OS service.
 * @returns {{ success: boolean, error?: string }}
 */
export function uninstallDaemon() {
  const platform = getPlatformSupport()
  if (!platform.supported) {
    return { success: false, error: platform.reason }
  }

  try {
    if (platform.platform === 'macos') {
      return uninstallMacOS()
    } else {
      return uninstallLinux()
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

function uninstallMacOS() {
  try {
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' })
  } catch { /* ignore */ }

  try {
    if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH)
  } catch { /* ignore */ }

  // 📖 Clean up daemon status file
  try {
    if (existsSync(DAEMON_STATUS_FILE)) unlinkSync(DAEMON_STATUS_FILE)
  } catch { /* ignore */ }

  return { success: true }
}

function uninstallLinux() {
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null`, { stdio: 'pipe' })
    execSync(`systemctl --user disable ${SERVICE_NAME} 2>/dev/null`, { stdio: 'pipe' })
  } catch { /* ignore */ }

  try {
    if (existsSync(SERVICE_PATH)) unlinkSync(SERVICE_PATH)
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
  } catch { /* ignore */ }

  try {
    if (existsSync(DAEMON_STATUS_FILE)) unlinkSync(DAEMON_STATUS_FILE)
  } catch { /* ignore */ }

  return { success: true }
}

// ─── Restart daemon ──────────────────────────────────────────────────────────

/**
 * 📖 Restart the daemon via the OS service manager.
 * @returns {{ success: boolean, error?: string }}
 */
export function restartDaemon() {
  const platform = getPlatformSupport()
  if (!platform.supported) {
    return { success: false, error: platform.reason }
  }

  try {
    if (platform.platform === 'macos') {
      // 📖 launchd: unload + load to restart
      try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' }) } catch { /* ignore */ }
      execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'pipe' })
    } else {
      execSync(`systemctl --user restart ${SERVICE_NAME}`, { stdio: 'pipe' })
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ─── Stop daemon (kill without uninstalling the service) ────────────────────

/**
 * 📖 Stop the daemon process without removing the OS service.
 * 📖 On macOS with KeepAlive:true, launchd may restart it automatically.
 *    Use uninstallDaemon() if you want it gone permanently.
 * @returns {{ success: boolean, error?: string, willRestart?: boolean }}
 */
export function stopDaemon() {
  const info = getDaemonInfo()
  if (!info?.pid) {
    return { success: false, error: 'No daemon running (no daemon.json found).' }
  }

  if (!isPidAlive(info.pid)) {
    // 📖 Already dead, clean up stale status file
    try { unlinkSync(DAEMON_STATUS_FILE) } catch { /* ignore */ }
    return { success: true }
  }

  try {
    process.kill(info.pid, 'SIGTERM')
  } catch (err) {
    return { success: false, error: `Failed to send SIGTERM to PID ${info.pid}: ${err.message}` }
  }

  // 📖 Clean up status file
  try { unlinkSync(DAEMON_STATUS_FILE) } catch { /* ignore */ }

  // 📖 Warn the user if the OS service will auto-restart it
  const serviceInstalled = existsSync(PLIST_PATH) || existsSync(SERVICE_PATH)
  return {
    success: true,
    willRestart: serviceInstalled,
  }
}

/**
 * 📖 Force-kill the daemon process (SIGKILL). Emergency escape hatch.
 * @returns {{ success: boolean, error?: string }}
 */
export function killDaemonProcess() {
  const info = getDaemonInfo()
  if (!info?.pid) {
    return { success: false, error: 'No daemon PID found.' }
  }

  try {
    if (isPidAlive(info.pid)) {
      process.kill(info.pid, 'SIGKILL')
    }
  } catch (err) {
    return { success: false, error: `Failed to kill PID ${info.pid}: ${err.message}` }
  }

  // 📖 Clean up status file
  try { unlinkSync(DAEMON_STATUS_FILE) } catch { /* ignore */ }
  return { success: true }
}

// ─── Version mismatch detection ─────────────────────────────────────────────

/**
 * 📖 Check if the running daemon version differs from the installed FCM version.
 * 📖 Returns null if no mismatch, otherwise { daemonVersion, installedVersion }.
 * @returns {{ daemonVersion: string, installedVersion: string } | null}
 */
export function getVersionMismatch() {
  const info = getDaemonInfo()
  if (!info?.version) return null

  try {
    const thisFile = fileURLToPath(import.meta.url)
    const pkgPath = join(dirname(thisFile), '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.version && pkg.version !== info.version) {
      return { daemonVersion: info.version, installedVersion: pkg.version }
    }
  } catch { /* ignore */ }

  return null
}

// ─── Log path ────────────────────────────────────────────────────────────────

/**
 * 📖 Get path to the daemon stdout log.
 * @returns {string}
 */
export function getDaemonLogPath() {
  return DAEMON_STDOUT_LOG
}
