/**
 * @file src/tool-launchers.js
 * @description Auto-configure and launch external coding tools from the selected model row.
 *
 * @details
 *   📖 This module extends the existing "pick a model and press Enter" workflow to
 *   external CLIs that can consume OpenAI-compatible or provider-specific settings.
 *
 *   📖 The design is pragmatic:
 *   - Write a small managed config file when the tool's config shape is stable enough
 *   - Always export the runtime environment variables before spawning the tool
 *   - Keep each launcher isolated so a partial integration does not break others
 *
 *   📖 Some tools still have weaker official support for arbitrary custom providers.
 *   For those, we prefer a transparent warning over pretending the integration is
 *   fully official. The user still gets a reproducible env/config handoff.
 *
 *   📖 Goose: writes custom provider JSON + secrets.yaml + updates config.yaml (GOOSE_PROVIDER/GOOSE_MODEL)
 *   📖 Crush: writes crush.json with provider config + models.large/small defaults
 *   📖 Pi: uses --provider/--model CLI flags for guaranteed auto-selection
 *   📖 Aider: writes ~/.aider.conf.yml + passes --model flag
 *   📖 Claude Code: uses ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN only (mirrors free-claude-code)
 *   📖 Codex CLI: uses a custom model_provider override so Codex stays in explicit API-provider mode
 *   📖 Gemini CLI: proxy mode is capability-gated because older builds do not support custom base URL routing cleanly
 *
 * @functions
 *   → `resolveLauncherModelId` — choose the provider-specific id or proxy slug for a launch
 *   → `buildCodexProxyArgs` — force Codex into a proxy-backed custom provider config
 *   → `inspectGeminiCliSupport` — detect whether the installed Gemini CLI can use proxy mode safely
 *   → `writeGooseConfig` — install provider + set GOOSE_PROVIDER/GOOSE_MODEL in config.yaml
 *   → `writeCrushConfig` — write provider + models.large/small to crush.json
 *   → `startExternalTool` — configure and launch the selected external tool mode
 *
 * @exports resolveLauncherModelId, buildCodexProxyArgs, inspectGeminiCliSupport, startExternalTool
 *
 * @see src/tool-metadata.js
 * @see src/provider-metadata.js
 * @see sources.js
 */

import chalk from 'chalk'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { sources } from '../sources.js'
import { PROVIDER_COLOR } from './render-table.js'
import { getApiKey, getProxySettings } from './config.js'
import { ENV_VAR_NAMES, isWindows } from './provider-metadata.js'
import { getToolMeta } from './tool-metadata.js'
import { ensureProxyRunning, resolveProxyModelId } from './opencode.js'
import { PROVIDER_METADATA } from './provider-metadata.js'

const OPENAI_COMPAT_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
]
const ANTHROPIC_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
]
const GEMINI_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_VERTEX_BASE_URL',
]
const PROXY_SANITIZED_ENV_KEYS = [...OPENAI_COMPAT_ENV_KEYS, ...ANTHROPIC_ENV_KEYS, ...GEMINI_ENV_KEYS]
const GEMINI_PROXY_MIN_VERSION = '0.34.0'
const EXPERIMENTAL_PROXY_TOOLS_NOTE = 'FCM Proxy V2 support for external tools is still in beta, so some launch and authentication flows can remain flaky while the integration stabilizes.'

function ensureDir(filePath) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function backupIfExists(filePath) {
  if (!existsSync(filePath)) return null
  const backupPath = `${filePath}.backup-${Date.now()}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(filePath, value) {
  ensureDir(filePath)
  writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function getProviderBaseUrl(providerKey) {
  const url = sources[providerKey]?.url
  if (!url) return null
  return url
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/predictions$/i, '')
}

function deleteEnvKeys(env, keys) {
  for (const key of keys) delete env[key]
}

function cloneInheritedEnv(inheritedEnv = process.env, sanitizeKeys = []) {
  const env = { ...inheritedEnv }
  deleteEnvKeys(env, sanitizeKeys)
  return env
}

function applyOpenAiCompatEnv(env, apiKey, baseUrl, modelId) {
  if (!apiKey || !baseUrl || !modelId) return env
  env.OPENAI_API_KEY = apiKey
  env.OPENAI_BASE_URL = baseUrl
  env.OPENAI_API_BASE = baseUrl
  env.OPENAI_MODEL = modelId
  env.LLM_API_KEY = apiKey
  env.LLM_BASE_URL = baseUrl
  env.LLM_MODEL = `openai/${modelId}`
  return env
}

/**
 * 📖 resolveLauncherModelId keeps proxy-backed launches on the universal
 * 📖 `fcm-proxy` catalog slug instead of leaking a provider-specific upstream id.
 *
 * @param {{ label?: string, modelId?: string }} model
 * @param {boolean} useProxy
 * @returns {string}
 */
export function resolveLauncherModelId(model, useProxy = false) {
  if (useProxy) return resolveProxyModelId(model)
  return model?.modelId ?? ''
}

export function buildToolEnv(mode, model, config, options = {}) {
  const {
    sanitize = false,
    includeCompatDefaults = true,
    includeProviderEnv = true,
    inheritedEnv = process.env,
  } = options
  const providerKey = model.providerKey
  const providerUrl = sources[providerKey]?.url || ''
  const baseUrl = getProviderBaseUrl(providerKey)
  const apiKey = getApiKey(config, providerKey)
  const env = cloneInheritedEnv(inheritedEnv, sanitize ? PROXY_SANITIZED_ENV_KEYS : [])
  const providerEnvName = ENV_VAR_NAMES[providerKey]
  if (includeProviderEnv && providerEnvName && apiKey) env[providerEnvName] = apiKey

  // 📖 OpenAI-compatible defaults reused by multiple CLIs.
  if (includeCompatDefaults && apiKey && baseUrl) {
    env.OPENAI_API_KEY = apiKey
    env.OPENAI_BASE_URL = baseUrl
    env.OPENAI_API_BASE = baseUrl
    env.OPENAI_MODEL = model.modelId
    env.LLM_API_KEY = apiKey
    env.LLM_BASE_URL = baseUrl
    env.LLM_MODEL = `openai/${model.modelId}`
  }

  // 📖 Provider-specific envs for tools that expect a different wire format.
  if (mode === 'claude-code' && apiKey && baseUrl) {
    env.ANTHROPIC_AUTH_TOKEN = apiKey
    env.ANTHROPIC_BASE_URL = baseUrl
    env.ANTHROPIC_MODEL = model.modelId
  }

  if (mode === 'gemini' && apiKey && baseUrl) {
    env.GEMINI_API_KEY = apiKey
    env.GOOGLE_API_KEY = apiKey
    env.GOOGLE_GEMINI_BASE_URL = baseUrl
  }

  return { env, apiKey, baseUrl, providerUrl }
}

export function buildCodexProxyArgs(baseUrl) {
  return [
    '-c', 'model_provider="fcm_proxy"',
    '-c', 'model_providers.fcm_proxy.name="FCM Proxy V2"',
    '-c', `model_providers.fcm_proxy.base_url=${JSON.stringify(baseUrl)}`,
    '-c', 'model_providers.fcm_proxy.env_key="FCM_PROXY_API_KEY"',
    '-c', 'model_providers.fcm_proxy.wire_api="responses"',
  ]
}

function compareSemver(a, b) {
  const left = String(a || '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const right = String(b || '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const length = Math.max(left.length, right.length)
  for (let idx = 0; idx < length; idx++) {
    const lhs = left[idx] || 0
    const rhs = right[idx] || 0
    if (lhs > rhs) return 1
    if (lhs < rhs) return -1
  }
  return 0
}

function findExecutableOnPath(command) {
  const pathValue = process.env.PATH || ''
  const candidates = process.platform === 'win32'
    ? [command, `${command}.cmd`, `${command}.exe`]
    : [command]

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate)
      try {
        accessSync(fullPath, constants.X_OK)
        return fullPath
      } catch { /* not executable */ }
    }
  }
  return null
}

function findPackageJsonUpwards(startPath) {
  let current = dirname(startPath)
  while (current && current !== dirname(current)) {
    const packageJsonPath = join(current, 'package.json')
    if (existsSync(packageJsonPath)) return packageJsonPath
    current = dirname(current)
  }
  return null
}

function detectGeminiCliVersion(binaryPath) {
  if (!binaryPath) return null
  try {
    const realPath = realpathSync(binaryPath)
    const versionMatch = realPath.match(/gemini-cli[\\/](\d+\.\d+\.\d+)(?:[\\/]|$)/)
    if (versionMatch?.[1]) return versionMatch[1]

    const packageJsonPath = findPackageJsonUpwards(realPath)
    if (!packageJsonPath) return null
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    if (typeof pkg?.version === 'string' && pkg.version.length > 0) {
      return pkg.version
    }
  } catch { /* best effort */ }
  return null
}

export function extractGeminiConfigError(output) {
  const text = String(output || '').trim()
  if (!text.includes('Invalid configuration in ')) return null
  const lines = text.split(/\r?\n/).filter(Boolean)
  return lines.slice(0, 8).join('\n')
}

export function inspectGeminiCliSupport(options = {}) {
  const binaryPath = options.binaryPath || findExecutableOnPath(options.command || 'gemini')
  if (!binaryPath) {
    return {
      installed: false,
      version: null,
      supportsProxyBaseUrl: false,
      configError: null,
      reason: 'Gemini CLI is not installed in PATH.',
    }
  }

  const version = options.version || detectGeminiCliVersion(binaryPath)
  const helpResult = options.helpResult || spawnSync(binaryPath, ['--help'], {
    encoding: 'utf8',
    timeout: 5000,
    env: options.inheritedEnv || process.env,
  })
  const helpOutput = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`.trim()
  const configError = extractGeminiConfigError(helpOutput)
  const supportsProxyBaseUrl = version ? compareSemver(version, GEMINI_PROXY_MIN_VERSION) >= 0 : false

  return {
    installed: true,
    version,
    supportsProxyBaseUrl,
    configError,
    reason: supportsProxyBaseUrl
      ? null
      : `Gemini CLI ${version || '(unknown version)'} does not expose stable custom base URL support for proxy mode yet.`,
  }
}

function spawnCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: isWindows,
      detached: false,
      env,
    })

    child.on('exit', (code) => resolve(code))
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error(chalk.red(`  X Could not find "${command}" in PATH.`))
        resolve(1)
      } else {
        reject(err)
      }
    })
  })
}

function writeAiderConfig(model, apiKey, baseUrl) {
  const filePath = join(homedir(), '.aider.conf.yml')
  const backupPath = backupIfExists(filePath)
  const content = [
    '# 📖 Managed by free-coding-models',
    `openai-api-base: ${baseUrl}`,
    `openai-api-key: ${apiKey}`,
    `model: openai/${model.modelId}`,
    '',
  ].join('\n')
  ensureDir(filePath)
  writeFileSync(filePath, content)
  return { filePath, backupPath }
}

function writeCrushConfig(model, apiKey, baseUrl, providerId) {
  const filePath = join(homedir(), '.config', 'crush', 'crush.json')
  const backupPath = backupIfExists(filePath)
  const config = readJson(filePath, { $schema: 'https://charm.land/crush.json' })
  // 📖 Remove legacy disable_default_providers — it can prevent Crush from auto-selecting models
  if (config.options && config.options.disable_default_providers) {
    delete config.options.disable_default_providers
  }
  if (!config.providers || typeof config.providers !== 'object') config.providers = {}
  config.providers[providerId] = {
    name: 'Free Coding Models',
    type: 'openai-compat',
    base_url: baseUrl,
    api_key: apiKey,
    models: [
      {
        name: model.label,
        id: model.modelId,
      },
    ],
  }
  // 📖 Crush expects structured selected models at config.models.{large,small}.
  // 📖 Setting both large AND small ensures Crush auto-selects the model in interactive mode.
  config.models = {
    ...(config.models && typeof config.models === 'object' ? config.models : {}),
    large: { model: model.modelId, provider: providerId },
    small: { model: model.modelId, provider: providerId },
  }
  writeJson(filePath, config)
  return { filePath, backupPath }
}

function writeGeminiConfig(model) {
  const filePath = join(homedir(), '.gemini', 'settings.json')
  const backupPath = backupIfExists(filePath)
  const config = readJson(filePath, {})
  config.model = model.modelId
  writeJson(filePath, config)
  return { filePath, backupPath }
}

function writeQwenConfig(model, providerKey, apiKey, baseUrl) {
  const filePath = join(homedir(), '.qwen', 'settings.json')
  const backupPath = backupIfExists(filePath)
  const config = readJson(filePath, {})
  if (!config.modelProviders || typeof config.modelProviders !== 'object') config.modelProviders = {}
  if (!Array.isArray(config.modelProviders.openai)) config.modelProviders.openai = []
  const nextEntry = {
    id: model.modelId,
    name: model.label,
    envKey: ENV_VAR_NAMES[providerKey] || 'OPENAI_API_KEY',
    baseUrl,
  }
  const filtered = config.modelProviders.openai.filter((entry) => entry?.id !== model.modelId)
  filtered.unshift(nextEntry)
  config.modelProviders.openai = filtered
  config.model = model.modelId
  writeJson(filePath, config)
  return { filePath, backupPath, envKey: nextEntry.envKey, apiKey }
}

function writePiConfig(model, apiKey, baseUrl) {
  // 📖 Write models.json with the selected provider config
  const modelsFilePath = join(homedir(), '.pi', 'agent', 'models.json')
  const modelsBackupPath = backupIfExists(modelsFilePath)
  const modelsConfig = readJson(modelsFilePath, { providers: {} })
  if (!modelsConfig.providers || typeof modelsConfig.providers !== 'object') modelsConfig.providers = {}
  modelsConfig.providers.freeCodingModels = {
    baseUrl,
    api: 'openai-completions',
    apiKey,
    models: [{ id: model.modelId, name: model.label }],
  }
  writeJson(modelsFilePath, modelsConfig)

  // 📖 Write settings.json to set the model as default on next launch
  const settingsFilePath = join(homedir(), '.pi', 'agent', 'settings.json')
  const settingsBackupPath = backupIfExists(settingsFilePath)
  const settingsConfig = readJson(settingsFilePath, {})
  settingsConfig.defaultProvider = 'freeCodingModels'
  settingsConfig.defaultModel = model.modelId
  writeJson(settingsFilePath, settingsConfig)

  return { filePath: modelsFilePath, backupPath: modelsBackupPath, settingsFilePath, settingsBackupPath }
}

// 📖 writeGooseConfig: Install/update the provider in Goose's custom_providers/, set the
// 📖 API key in secrets.yaml, and update config.yaml with GOOSE_PROVIDER + GOOSE_MODEL
// 📖 so Goose auto-selects the model on launch.
function writeGooseConfig(model, apiKey, baseUrl, providerKey) {
  const home = homedir()
  const providerId = `fcm-${providerKey}`
  const providerLabel = PROVIDER_METADATA[providerKey]?.label || sources[providerKey]?.name || providerKey
  const secretEnvName = `FCM_${providerKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`

  // 📖 Step 1: Write custom provider JSON (same format as endpoint-installer)
  const providerDir = join(home, '.config', 'goose', 'custom_providers')
  const providerFilePath = join(providerDir, `${providerId}.json`)
  ensureDir(providerFilePath)
  const providerConfig = {
    name: providerId,
    engine: 'openai',
    display_name: `FCM ${providerLabel}`,
    description: `Managed by free-coding-models for ${providerLabel}`,
    api_key_env: secretEnvName,
    base_url: baseUrl?.endsWith('/chat/completions') ? baseUrl : (baseUrl || ''),
    models: [{ name: model.modelId, context_limit: 128000 }],
    supports_streaming: true,
    requires_auth: true,
  }
  writeFileSync(providerFilePath, JSON.stringify(providerConfig, null, 2) + '\n')

  // 📖 Step 2: Write API key to secrets.yaml (simple key: value format)
  const secretsPath = join(home, '.config', 'goose', 'secrets.yaml')
  let secretsContent = ''
  if (existsSync(secretsPath)) {
    secretsContent = readFileSync(secretsPath, 'utf8')
  }
  // 📖 Replace existing secret or append new one
  const secretLine = `${secretEnvName}: ${JSON.stringify(apiKey)}`
  const secretRegex = new RegExp(`^${secretEnvName}:.*$`, 'm')
  if (secretRegex.test(secretsContent)) {
    secretsContent = secretsContent.replace(secretRegex, secretLine)
  } else {
    secretsContent = secretsContent.trimEnd() + '\n' + secretLine + '\n'
  }
  ensureDir(secretsPath)
  writeFileSync(secretsPath, secretsContent)

  // 📖 Step 3: Update config.yaml — set GOOSE_PROVIDER and GOOSE_MODEL at top level
  const configPath = join(home, '.config', 'goose', 'config.yaml')
  let configContent = ''
  if (existsSync(configPath)) {
    configContent = readFileSync(configPath, 'utf8')
  }
  // 📖 Replace or add GOOSE_PROVIDER line
  if (/^GOOSE_PROVIDER:.*/m.test(configContent)) {
    configContent = configContent.replace(/^GOOSE_PROVIDER:.*/m, `GOOSE_PROVIDER: ${providerId}`)
  } else {
    configContent = `GOOSE_PROVIDER: ${providerId}\n` + configContent
  }
  // 📖 Replace or add GOOSE_MODEL line
  if (/^GOOSE_MODEL:.*/m.test(configContent)) {
    configContent = configContent.replace(/^GOOSE_MODEL:.*/m, `GOOSE_MODEL: ${model.modelId}`)
  } else {
    // 📖 Insert after GOOSE_PROVIDER line
    configContent = configContent.replace(/^(GOOSE_PROVIDER:.*)/m, `$1\nGOOSE_MODEL: ${model.modelId}`)
  }
  writeFileSync(configPath, configContent)

  return { providerFilePath, secretsPath, configPath }
}

function writeAmpConfig(model, baseUrl) {
  const filePath = join(homedir(), '.config', 'amp', 'settings.json')
  const backupPath = backupIfExists(filePath)
  const config = readJson(filePath, {})
  config['amp.url'] = baseUrl
  config['amp.model'] = model.modelId
  writeJson(filePath, config)
  return { filePath, backupPath }
}

function printConfigResult(toolName, result) {
  if (!result?.filePath) return
  console.log(chalk.dim(`  📄 ${toolName} config updated: ${result.filePath}`))
  if (result.backupPath) console.log(chalk.dim(`  💾 Backup: ${result.backupPath}`))
}

function printExperimentalProxyNote() {
  console.log(chalk.dim(`  ${EXPERIMENTAL_PROXY_TOOLS_NOTE}`))
}

export async function startExternalTool(mode, model, config) {
  const meta = getToolMeta(mode)
  const { env, apiKey, baseUrl } = buildToolEnv(mode, model, config)
  const proxySettings = getProxySettings(config)

  if (!apiKey && mode !== 'amp') {
    // 📖 Color provider name the same way as in the main table
    const providerRgb = PROVIDER_COLOR[model.providerKey] ?? [105, 190, 245]
    const providerName = sources[model.providerKey]?.name || model.providerKey
    const coloredProviderName = chalk.bold.rgb(...providerRgb)(providerName)
    console.log(chalk.yellow(`  ⚠ No API key configured for ${coloredProviderName}.`))
    console.log(chalk.dim('  Configure the provider first from the Settings screen (P) or via env vars.'))
    console.log()
    return 1
  }

  console.log(chalk.cyan(`  ▶ Launching ${meta.label} with ${chalk.bold(model.label)}...`))

  if (mode === 'aider') {
    printConfigResult(meta.label, writeAiderConfig(model, apiKey, baseUrl))
    return spawnCommand('aider', ['--model', `openai/${model.modelId}`], env)
  }

  if (mode === 'crush') {
    let crushApiKey = apiKey
    let crushBaseUrl = baseUrl
    let providerId = 'freeCodingModels'
    let launchModelId = resolveLauncherModelId(model, false)

    if (proxySettings.enabled) {
      const started = await ensureProxyRunning(config)
      crushApiKey = started.proxyToken
      crushBaseUrl = `http://127.0.0.1:${started.port}/v1`
      providerId = 'freeCodingModelsProxy'
      launchModelId = resolveLauncherModelId(model, true)
      console.log(chalk.dim(`  📖 Crush will use the local FCM proxy on :${started.port} for this launch.`))
    } else {
      console.log(chalk.dim('  📖 Crush will use the provider directly for this launch.'))
    }

    const launchModel = { ...model, modelId: launchModelId }
    applyOpenAiCompatEnv(env, crushApiKey, crushBaseUrl, launchModelId)
    printConfigResult(meta.label, writeCrushConfig(launchModel, crushApiKey, crushBaseUrl, providerId))
    return spawnCommand('crush', [], env)
  }

  if (mode === 'goose') {
    let gooseBaseUrl = sources[model.providerKey]?.url || baseUrl || ''
    let gooseApiKey = apiKey
    let gooseModelId = resolveLauncherModelId(model, false)
    let gooseProviderKey = model.providerKey

    if (proxySettings.enabled) {
      const started = await ensureProxyRunning(config)
      gooseApiKey = started.proxyToken
      gooseBaseUrl = `http://127.0.0.1:${started.port}/v1/chat/completions`
      gooseModelId = resolveLauncherModelId(model, true)
      gooseProviderKey = 'proxy'
      console.log(chalk.dim(`  📖 Goose will use the local FCM proxy on :${started.port} for this launch.`))
    }

    // 📖 Write Goose config: custom provider JSON + secrets.yaml + config.yaml (GOOSE_PROVIDER/GOOSE_MODEL)
    const gooseResult = writeGooseConfig({ ...model, modelId: gooseModelId }, gooseApiKey, gooseBaseUrl, gooseProviderKey)
    console.log(chalk.dim(`  📄 Goose config updated: ${gooseResult.configPath}`))
    console.log(chalk.dim(`  📄 Provider installed: ${gooseResult.providerFilePath}`))

    // 📖 Also set env vars as belt-and-suspenders
    env.GOOSE_PROVIDER = `fcm-${gooseProviderKey}`
    env.GOOSE_MODEL = gooseModelId
    applyOpenAiCompatEnv(env, gooseApiKey, gooseBaseUrl.replace(/\/chat\/completions$/, ''), gooseModelId)
    return spawnCommand('goose', [], env)
  }

  // 📖 Claude Code, Codex, and Gemini require the FCM Proxy V2 background service.
  // 📖 Without it, these tools cannot connect to the free providers (protocol mismatch / no direct support).
  if (mode === 'claude-code' || mode === 'codex' || mode === 'gemini') {
    if (!proxySettings.enabled) {
      console.log()
      console.log(chalk.red(`  ✖ ${meta.label} requires FCM Proxy V2 to work with free providers.`))
      console.log()
      console.log(chalk.yellow('  The proxy translates between provider protocols and handles key rotation,'))
      console.log(chalk.yellow('  which is required for this tool to connect.'))
      console.log(chalk.dim(`  ${EXPERIMENTAL_PROXY_TOOLS_NOTE}`))
      console.log()
      console.log(chalk.white('  To enable it:'))
      console.log(chalk.dim('    1. Press ') + chalk.bold.white('J') + chalk.dim(' to open FCM Proxy V2 settings'))
      console.log(chalk.dim('    2. Enable ') + chalk.bold.white('Proxy mode') + chalk.dim(' and install the ') + chalk.bold.white('background service'))
      console.log(chalk.dim('    3. Come back and select your model again'))
      console.log()
      return 1
    }
  }

  if (mode === 'claude-code') {
    // 📖 Claude Code needs Anthropic-compatible wire format (POST /v1/messages).
    // 📖 Mirror free-claude-code: one auth env only (`ANTHROPIC_AUTH_TOKEN`) plus base URL.
    const started = await ensureProxyRunning(config)
    const { env: proxyEnv } = buildToolEnv(mode, model, config, {
      sanitize: true,
      includeCompatDefaults: false,
      includeProviderEnv: false,
    })
    const proxyBase = `http://127.0.0.1:${started.port}`
    const launchModelId = resolveLauncherModelId(model, true)
    proxyEnv.ANTHROPIC_BASE_URL = proxyBase
    proxyEnv.ANTHROPIC_AUTH_TOKEN = started.proxyToken
    proxyEnv.ANTHROPIC_MODEL = launchModelId
    console.log(chalk.dim(`  📖 Claude Code routed through FCM proxy on :${started.port} (Anthropic translation enabled)`))
    return spawnCommand('claude', ['--model', launchModelId], proxyEnv)
  }

  if (mode === 'codex') {
    const started = await ensureProxyRunning(config)
    const { env: proxyEnv } = buildToolEnv(mode, model, config, {
      sanitize: true,
      includeCompatDefaults: false,
      includeProviderEnv: false,
    })
    const launchModelId = resolveLauncherModelId(model, true)
    const proxyBaseUrl = `http://127.0.0.1:${started.port}/v1`
    proxyEnv.FCM_PROXY_API_KEY = started.proxyToken
    console.log(chalk.dim(`  📖 Codex routed through FCM proxy on :${started.port}`))
    return spawnCommand('codex', [...buildCodexProxyArgs(proxyBaseUrl), '--model', launchModelId], proxyEnv)
  }

  if (mode === 'gemini') {
    const geminiSupport = inspectGeminiCliSupport()
    if (geminiSupport.configError) {
      console.log()
      console.log(chalk.red('  ✖ Gemini CLI configuration is invalid, so the proxy launch is blocked before auth.'))
      console.log(chalk.dim(`  ${geminiSupport.configError.split('\n').join('\n  ')}`))
      printExperimentalProxyNote()
      console.log(chalk.dim('  Fix ~/.gemini/settings.json, then try again.'))
      console.log()
      return 1
    }
    if (!geminiSupport.supportsProxyBaseUrl) {
      console.log()
      const versionLabel = geminiSupport.version ? `v${geminiSupport.version}` : 'this installed version'
      console.log(chalk.red(`  ✖ Gemini CLI ${versionLabel} is not proxy-compatible in FCM yet.`))
      console.log(chalk.yellow('  This build does not expose the custom base-URL contract we need, so launching it through the proxy would be misleading.'))
      printExperimentalProxyNote()
      console.log(chalk.dim(`  Expected: Gemini CLI ${GEMINI_PROXY_MIN_VERSION}+ with stable proxy base URL support.`))
      console.log()
      return 1
    }

    const started = await ensureProxyRunning(config)
    const launchModelId = resolveLauncherModelId(model, true)
    const { env: proxyEnv } = buildToolEnv(mode, model, config, {
      sanitize: true,
      includeCompatDefaults: false,
      includeProviderEnv: false,
    })
    proxyEnv.GEMINI_API_KEY = started.proxyToken
    proxyEnv.GOOGLE_API_KEY = started.proxyToken
    proxyEnv.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${started.port}/v1`
    printConfigResult(meta.label, writeGeminiConfig({ ...model, modelId: launchModelId }))
    console.log(chalk.dim(`  📖 Gemini routed through FCM proxy on :${started.port}`))
    return spawnCommand('gemini', ['--model', launchModelId], proxyEnv)
  }

  if (mode === 'qwen') {
    printConfigResult(meta.label, writeQwenConfig(model, model.providerKey, apiKey, baseUrl))
    return spawnCommand('qwen', [], env)
  }

  if (mode === 'openhands') {
    // 📖 OpenHands supports LLM_MODEL env var to set the default model
    env.LLM_MODEL = model.modelId
    env.LLM_API_KEY = apiKey || env.LLM_API_KEY
    if (baseUrl) env.LLM_BASE_URL = baseUrl
    console.log(chalk.dim(`  📖 OpenHands launched with model: ${model.modelId}`))
    return spawnCommand('openhands', ['--override-with-envs'], env)
  }

  if (mode === 'amp') {
    printConfigResult(meta.label, writeAmpConfig(model, baseUrl))
    console.log(chalk.dim(`  📖 Amp config updated with model: ${model.modelId}`))
    return spawnCommand('amp', [], env)
  }

  if (mode === 'pi') {
    const piResult = writePiConfig(model, apiKey, baseUrl)
    printConfigResult(meta.label, { filePath: piResult.filePath, backupPath: piResult.backupPath })
    printConfigResult(meta.label, { filePath: piResult.settingsFilePath, backupPath: piResult.settingsBackupPath })
    // 📖 Pi supports --provider and --model flags for guaranteed auto-selection
    return spawnCommand('pi', ['--provider', 'freeCodingModels', '--model', model.modelId, '--api-key', apiKey], env)
  }

  console.log(chalk.red(`  X Unsupported external tool mode: ${mode}`))
  return 1
}
