# Changelog
---

## [0.3.37] - 2026-04-09

### Added
- **🔮 Hermes Agent** — Configures Hermes via `hermes config set`, restarts the gateway, and launches `hermes chat`. Supports all OpenAI-compatible providers.
- **▶️ Continue CLI** — Writes `~/.continue/config.yaml` with `provider: openai` + `apiBase` and launches `cn`.
- **🧠 Cline CLI** — Writes `~/.cline/globalState.json` with OpenAI-compatible config and launches `cline`.
- `--hermes`, `--continue`, `--cline` CLI flags, `Z` cycle entries, command palette actions, and Install Endpoints support for all three tools.
