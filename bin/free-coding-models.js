#!/usr/bin/env node
/**
 * @file free-coding-models.js
 * @description Live terminal availability checker for coding LLM models with OpenCode & OpenClaw integration.
 */

// 📖 --dev mode: must set FCM_DEV before any module imports resolve daemon paths
if (process.argv.includes('--dev')) {
  process.env.FCM_DEV = '1'
}

import chalk from 'chalk';
import { parseArgs, TIER_LETTER_MAP } from '../src/utils.js';
import { loadConfig } from '../src/config.js';
import { ensureTelemetryConfig } from '../src/telemetry.js';
import { ensureFavoritesConfig } from '../src/favorites.js';
import { buildCliHelpText } from '../src/cli-help.js';
import { ALT_LEAVE } from '../src/constants.js';
import { runApp } from '../src/app.js';

// Global error handlers to ensure terminal is restored if something crashes catastrophically
process.on('uncaughtException', (err) => {
  if (process.argv.some(arg => arg === '--daemon')) {
    console.error(err);
    return;
  }
  process.stdout.write(ALT_LEAVE);
  console.error(chalk.red('\n[Fatal Error] An unhandled exception occurred.'));
  console.error(err);
  console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or use the feedback form (I key) to report this to the author.'));
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  if (process.argv.some(arg => arg === '--daemon')) {
    console.error(reason);
    return;
  }
  process.stdout.write(ALT_LEAVE);
  console.error(chalk.red('\n[Fatal Error] An unhandled promise rejection occurred.'));
  console.error(reason);
  console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or use the feedback form (I key) to report this to the author.'));
  process.exit(1);
});

async function main() {
  const cliArgs = parseArgs(process.argv);

  if (cliArgs.helpMode) {
    console.log();
    console.log(buildCliHelpText({ chalk, title: 'free-coding-models' }));
    console.log();
    process.exit(0);
  }

  // 📖 Router daemon lifecycle flags run before the TUI so automation and
  // 📖 editor integrations can manage the local OpenAI-compatible endpoint.
  if (cliArgs.daemonMode || cliArgs.daemonBackgroundMode || cliArgs.daemonStopMode || cliArgs.daemonStatusMode) {
    const {
      getRouterDaemonStatus,
      runRouterDaemon,
      startRouterDaemonBackground,
      stopRouterDaemon,
    } = await import('../src/router-daemon.js');

    if (cliArgs.daemonMode) {
      await runRouterDaemon();
      return;
    }

    const result = cliArgs.daemonBackgroundMode
      ? await startRouterDaemonBackground()
      : cliArgs.daemonStopMode
        ? await stopRouterDaemon()
        : await getRouterDaemonStatus();

    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  // Validate --tier early, before entering alternate screen
  if (cliArgs.tierFilter && !TIER_LETTER_MAP[cliArgs.tierFilter]) {
    console.error(chalk.red(`  Unknown tier "${cliArgs.tierFilter}". Valid tiers: S, A, B, C`));
    process.exit(1);
  }

  // 📖 --web mode: launch the web dashboard instead of the TUI
  if (cliArgs.webMode) {
    const { startWebServer } = await import('../web/server.js')
    const port = parseInt(process.env.FCM_PORT || '3333', 10)
    await startWebServer(port, { open: true })
    return
  }

  // 📖 Load JSON config
  const config = loadConfig();
  ensureTelemetryConfig(config);
  ensureFavoritesConfig(config);

  await runApp(cliArgs, config);
}

main().catch((err) => {
  process.stdout.write(ALT_LEAVE);
  console.error(chalk.red('\n[Fatal Error]'));
  console.error(err);
  console.error(chalk.yellow('\nPlease file an issue at https://github.com/vava-nessa/free-coding-models/issues or use the feedback form (I key) to report this to the author.'));
  process.exit(1);
});
