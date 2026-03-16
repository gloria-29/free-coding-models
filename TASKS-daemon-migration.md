# Task Tracker : FCM Proxy → Daemon Always-On Migration

## Status Global : ✅ Implémentation complète — En attente de review utilisateur

---

## Phase 1 : Token & Port stables
- [x] Modifier `src/config.js` — ajouter stableToken, daemonEnabled, daemonConsent
- [x] Modifier `src/opencode.js` — utiliser stableToken depuis config

## Phase 2 : Extraction topology + Traducteur Anthropic
- [x] Créer `src/proxy-topology.js` — extraction buildProxyTopologyFromConfig
- [x] Créer `src/anthropic-translator.js` — traduction Anthropic ↔ OpenAI
- [x] Modifier `src/proxy-server.js` — routes /v1/messages, /v1/health, updateAccounts()

## Phase 3 : Daemon Entry Point
- [x] Créer `bin/fcm-proxy-daemon.js` — standalone daemon headless
- [x] Modifier `package.json` — ajouter bin entry fcm-proxy-daemon

## Phase 4 : Daemon Manager
- [x] Créer `src/daemon-manager.js` — install/uninstall/status (launchd + systemd)

## Phase 5 : Intégration TUI
- [x] Modifier `src/overlays.js` — consent overlay + settings daemon section
- [x] Modifier `src/key-handler.js` — consent key handling
- [x] Modifier `src/opencode.js` — délégation au daemon
- [x] Modifier `bin/free-coding-models.js` — consent flow au démarrage

## Phase 6 : Tool Launchers
- [x] Modifier `src/tool-launchers.js` — Claude Code Anthropic endpoint
- [x] Modifier `src/endpoint-installer.js` — stable token/port

## Phase 7 : CLI Commands
- [x] Modifier `bin/free-coding-models.js` — daemon status/install/uninstall/restart/logs

## Phase 8 : Tests & Docs
- [x] Tests pour anthropic-translator.js (7 tests)
- [x] Tests pour proxy-topology.js (3 tests)
- [x] Vérifier pnpm test — 199 tests passent (189 existants + 10 nouveaux)
- [x] Mettre à jour CHANGELOG.md
- [x] Mettre à jour README.md
- [x] JSDoc headers sur les nouveaux fichiers

---

## Notes de session
- Session 1 (2026-03-16) : Plan créé, implémentation phases 1–7 complètes
- Session 2 (2026-03-16) : Tests validés (199/199), CHANGELOG mis à jour, JSDoc ajoutés
