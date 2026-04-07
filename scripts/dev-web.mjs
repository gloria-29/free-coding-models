#!/usr/bin/env node
/**
 * @file scripts/dev-web.mjs
 * @description Dev script that starts both the backend API server and the Vite dev server.
 * 📖 Checks if port 3333 is already in use (daemon running) before starting a new one.
 *    Starts Vite dev server with HMR + API proxy on port 5173.
 */
import { createServer } from 'node:http'
import { exec, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const API_PORT = parseInt(process.env.FCM_PORT || '3333', 10)

function checkPort(port) {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', (err) => { if (err.code === 'EADDRINUSE') resolve(true); else resolve(false) })
    s.once('listening', () => { s.close(); resolve(false) })
    s.listen(port)
  })
}

async function main() {
  console.log()
  console.log('  ⚡ free-coding-models dev:web')
  console.log()

  const apiRunning = await checkPort(API_PORT)

  if (apiRunning) {
    console.log(`  ✅ API server already running on port ${API_PORT}`)
  } else {
    console.log(`  🚀 Starting API server on port ${API_PORT}...`)
    const api = spawn('node', ['-e', `import('${join(ROOT, 'web/server.js').replace(/\\/g, '/')}').then(m => m.startWebServer(${API_PORT}, { open: false }))`], {
      stdio: 'inherit',
      cwd: ROOT,
    })
    api.on('error', (err) => { console.error('  ❌ Failed to start API server:', err.message); process.exit(1) })
    await new Promise((r) => setTimeout(r, 1500))
  }

  console.log(`  🚀 Starting Vite dev server...`)
  console.log()

  const vite = spawn('npx', ['vite', '--host'], { stdio: 'inherit', cwd: ROOT, shell: true })

  vite.on('error', (err) => { console.error('  ❌ Failed to start Vite:', err.message); process.exit(1) })

  const cleanup = () => {
    console.log('\n  🛑 Shutting down...')
    if (!apiRunning) api.kill()
    vite.kill()
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

main().catch(console.error)
