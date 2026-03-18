<p align="center">
  <img src="https://img.shields.io/npm/v/free-coding-models?color=76b900&label=npm&logo=npm" alt="npm version">
  <img src="https://img.shields.io/node/v/free-coding-models?color=76b900&logo=node.js" alt="node version">
  <img src="https://img.shields.io/npm/l/free-coding-models?color=76b900" alt="license">
  <img src="https://img.shields.io/badge/models-160-76b900?logo=nvidia" alt="models count">
  <img src="https://img.shields.io/badge/providers-20-blue" alt="providers count">
</p>

<h1 align="center">free-coding-models</h1>

<p align="center">
  <strong>Find the fastest free coding model in seconds</strong><br>
  <sub>Ping 160 models across 20 AI Free providers in real-time </sub><br><sub> Install Free API endpoints to your favorite AI coding tool: <br>OpenCode, OpenClaw, Crush, Goose, Aider, Qwen Code, OpenHands, Amp or Pi in one keystroke</sub>
</p>



<p align="center">

```bash
npm install -g free-coding-models
free-coding-models
```

</p>

<p align="center">
  <a href="#-why-this-tool">Why</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-providers">Providers</a> •
  <a href="#-usage">Usage</a> •
  <a href="#-tui-keys">TUI Keys</a> •
  <a href="#-contributing">Contributing</a>
</p>

<p align="center">
  <img src="demo.gif" alt="free-coding-models demo" width="100%">
</p>

<p align="center">
  <sub>Made with ❤️ and ☕ by <a href="https://vanessadepraute.dev">Vanessa Depraute</a> (aka <a href="https://vavanessa.dev">Vava-Nessa</a>)</sub>
</p>

---

## 💡 Why this tool?

There are **160+ free coding models** scattered across 20 providers. Which one is fastest right now? Which one is actually stable versus just lucky on the last ping?

This CLI pings them all in parallel, shows live latency, and calculates a **live Stability Score (0-100)**. Average latency alone is misleading if a model randomly spikes to 6 seconds; the stability score measures true reliability by combining **p95 latency** (30%), **jitter/variance** (30%), **spike rate** (20%), and **uptime** (20%). 

It then writes the model you pick directly into your coding tool's config — so you go from "which model?" to "coding" in under 10 seconds.

---

## ⚡ Quick Start

**① Get a free API key** — you only need one to get started:

**160 coding models** across 20 providers, ranked by [SWE-bench Verified](https://www.swebench.com).

| Provider | Models | Tier range | Free tier | Env var |
|----------|--------|-----------|-----------|--------|
| [NVIDIA NIM](https://build.nvidia.com) | 44 | S+ → C | 40 req/min (no credit card needed) | `NVIDIA_API_KEY` |
| [iFlow](https://platform.iflow.cn) | 11 | S+ → A+ | Free for individuals (no req limits, 7-day key expiry) | `IFLOW_API_KEY` |
| [ZAI](https://z.ai) | 7 | S+ → S | Free tier (generous quota) | `ZAI_API_KEY` |
| [Alibaba DashScope](https://modelstudio.console.alibabacloud.com) | 8 | S+ → A | 1M free tokens per model (Singapore region, 90 days) | `DASHSCOPE_API_KEY` |
| [Groq](https://console.groq.com/keys) | 10 | S → B | 30‑50 RPM per model (varies by model) | `GROQ_API_KEY` |
| [Cerebras](https://cloud.cerebras.ai) | 7 | S+ → B | Generous free tier (developer tier 10× higher limits) | `CEREBRAS_API_KEY` |
| [SambaNova](https://sambanova.ai/developers) | 12 | S+ → B | Dev tier generous quota | `SAMBANOVA_API_KEY` |
| [OpenRouter](https://openrouter.ai/keys) | 11 | S+ → C | Free on :free: 50/day <$10, 1000/day ≥$10 (20 req/min) | `OPENROUTER_API_KEY` |
| [Hugging Face](https://huggingface.co/settings/tokens) | 2 | S → B | Free monthly credits (~$0.10) | `HUGGINGFACE_API_KEY` |
| [Together AI](https://api.together.ai/settings/api-keys) | 7 | S+ → A- | Credits/promos vary by account (check console) | `TOGETHER_API_KEY` |
| [DeepInfra](https://deepinfra.com/login) | 2 | A- → B+ | 200 concurrent requests (default) | `DEEPINFRA_API_KEY` |
| [Fireworks AI](https://fireworks.ai) | 2 | S | $1 credits – 10 req/min without payment | `FIREWORKS_API_KEY` |
| [Mistral Codestral](https://codestral.mistral.ai) | 1 | B+ | 30 req/min, 2000/day | `CODESTRAL_API_KEY` |
| [Hyperbolic](https://app.hyperbolic.ai/settings) | 10 | S+ → A- | $1 free trial credits | `HYPERBOLIC_API_KEY` |
| [Scaleway](https://console.scaleway.com/iam/api-keys) | 7 | S+ → B+ | 1M free tokens | `SCALEWAY_API_KEY` |
| [Google AI Studio](https://aistudio.google.com/apikey) | 3 | B → C | 14.4K req/day, 30/min | `GOOGLE_API_KEY` |
| [SiliconFlow](https://cloud.siliconflow.cn/account/ak) | 6 | S+ → A | Free models: usually 100 RPM, varies by model | `SILICONFLOW_API_KEY` |
| [Cloudflare Workers AI](https://dash.cloudflare.com) | 6 | S → B | Free: 10k neurons/day, text-gen 300 RPM | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| [Perplexity API](https://www.perplexity.ai/settings/api) | 4 | A+ → B | Tiered limits by spend (default ~50 RPM) | `PERPLEXITY_API_KEY` |
| [Replicate](https://replicate.com/account/api-tokens) | 1 | A- | 6 req/min (no payment) – up to 3,000 RPM with payment | `REPLICATE_API_TOKEN` |

> 💡 One key is enough. Add more at any time with **`P`** inside the TUI.

### Tier scale

| Tier | SWE-bench | Best for |
|------|-----------|----------|
| **S+** | ≥ 70% | Complex refactors, real-world GitHub issues |
| **S** | 60–70% | Most coding tasks, strong general use |
| **A+/A** | 40–60% | Solid alternatives, targeted programming |
| **A-/B+** | 30–40% | Smaller tasks, constrained infra |
| **B/C** | < 30% | Code completion, edge/minimal setups |

**② Install and run:**

```bash
npm install -g free-coding-models
free-coding-models
```

On first run, you'll be prompted to enter your API key(s). You can skip providers and add more later with **`P`**.

Need to fix contrast because your terminal theme is fighting the TUI? Press **`G`** at any time to cycle **Auto → Dark → Light**. The switch recolors the full interface live: table, Settings, Help, Smart Recommend, Feedback, and Changelog.

**③ Pick a model and launch your tool:**

```
↑↓ navigate   →   Enter to launch
```

The model you select is automatically written into your tool's config (OpenCode, OpenClaw, Crush, etc.) and the tool opens immediately. Done.

If the active CLI tool is missing, FCM now catches it before launch, offers a tiny Yes/No install prompt, installs the tool with its official global command, then resumes the same model launch automatically.

> 💡 You can also run `free-coding-models --goose --tier S` to pre-filter to S-tier models for Goose before the TUI even opens.



## 🚀 Usage

### Common scenarios

```bash
# "I want the most reliable model right now"
free-coding-models --fiable

# "I want to configure Goose with an S-tier model"
free-coding-models --goose --tier S

# "I want NVIDIA's top models only"
free-coding-models --origin nvidia --tier S

# "Start with an elite-focused preset, then adjust filters live"
free-coding-models --premium

# "I want to script this — give me JSON"
free-coding-models --tier S --json | jq -r '.[0].modelId'

# "I want to configure OpenClaw with Groq's fastest model"
free-coding-models --openclaw --origin groq
```

### Tool launcher flags

| Flag | Launches |
|------|----------|
| `--opencode` | OpenCode CLI |
| `--opencode-desktop` | OpenCode Desktop |
| `--openclaw` | OpenClaw |
| `--crush` | Crush |
| `--goose` | Goose |
| `--aider` | Aider |
| `--qwen` | Qwen Code |
| `--openhands` | OpenHands |
| `--amp` | Amp |
| `--pi` | Pi |

Press **`Z`** in the TUI to cycle between tools without restarting.

→ **[Full flags reference](./docs/flags.md)**

---

## ⌨️ TUI Keys

| Key | Action |
|-----|--------|
| `↑↓` | Navigate models |
| `Enter` | Launch selected model in active tool |
| `Z` | Cycle target tool |
| `T` | Cycle tier filter |
| `D` | Cycle provider filter |
| `E` | Toggle configured-only mode |
| `F` | Favorite / unfavorite model |
| `G` | Cycle global theme (`Auto → Dark → Light`) |
| `Ctrl+P` | Open command palette (search + run actions) |
| `R/S/C/M/O/L/A/H/V/B/U` | Sort columns |
| `P` | Settings (API keys, providers, updates, theme) |
| `Q` | Smart Recommend overlay |
| `N` | Changelog |
| `W` | Cycle ping cadence |
| `I` | Feedback / bug report |
| `K` | Help overlay |
| `Ctrl+C` | Exit |

→ **[Stability score & column reference](./docs/stability.md)**

---

## ✨ Features

- **Parallel pings** — all 160 models tested simultaneously via native `fetch`
- **Adaptive monitoring** — 2s burst for 60s → 10s normal → 30s idle
- **Stability score** — composite 0–100 (p95 latency, jitter, spike rate, uptime)
- **Smart ranking** — top 3 highlighted 🥇🥈🥉
- **Favorites** — pin models with `F`, persisted across sessions
- **Configured-only default** — only shows providers you have keys for
- **Keyless latency** — models ping even without an API key (show 🔑 NO KEY)
- **Smart Recommend** — questionnaire picks the best model for your task type
- **Command Palette** — `Ctrl+P` opens a searchable action launcher for filters, sorting, overlays, and quick toggles
- **Install Endpoints** — push a full provider catalog into any tool's config (`Y`)
- **Missing tool bootstrap** — detect absent CLIs, offer one-click install, then continue the selected launch automatically
- **Width guardrail** — shows a warning instead of a broken table in narrow terminals
- **Readable everywhere** — semantic theme palette keeps table rows, overlays, badges, and help screens legible in dark and light terminals
- **Global theme switch** — `G` cycles `auto`, `dark`, and `light` live without restarting
- **Auto-retry** — timeout models keep getting retried

---

## 📋 Contributing

We welcome contributions — issues, PRs, new provider integrations.

**Q:** How accurate are the latency numbers?  
**A:** Real round-trip times measured by your machine. Results depend on your network and provider load at that moment.

**Q:** Can I add a new provider?  
**A:** Yes — see [`sources.js`](./sources.js) for the model catalog format.

→ **[Development guide](./docs/development.md)** · **[Config reference](./docs/config.md)** · **[Tool integrations](./docs/integrations.md)**

---

## 📧 Support

[GitHub Issues](https://github.com/vava-nessa/free-coding-models/issues) · [Discord](https://discord.gg/ZTNFHvvCkU)

---

## 📄 License

MIT © [vava](https://github.com/vava-nessa)

---

<p align="center">
  <strong>Contributors</strong><br>
  <a href="https://github.com/vava-nessa"><img src="https://avatars.githubusercontent.com/u/5466264?v=4&s=60" width="60" height="60" style="border-radius:50%" alt="vava-nessa"></a>
  <a href="https://github.com/erwinh22"><img src="https://avatars.githubusercontent.com/u/6641858?v=4&s=60" width="60" height="60" style="border-radius:50%" alt="erwinh22"></a>
  <a href="https://github.com/whit3rabbit"><img src="https://avatars.githubusercontent.com/u/12357518?v=4&s=60" width="60" height="60" style="border-radius:50%" alt="whit3rabbit"></a>
  <a href="https://github.com/skylaweber"><img src="https://avatars.githubusercontent.com/u/172871734?v=4&s=60" width="60" height="60" style="border-radius:50%" alt="skylaweber"></a>
  <a href="https://github.com/PhucTruong-ctrl"><img src="https://github.com/PhucTruong-ctrl.png?s=60" width="60" height="60" style="border-radius:50%" alt="PhucTruong-ctrl"></a>
  <br>
  <sub>
    <a href="https://github.com/vava-nessa">vava-nessa</a> &middot;
    <a href="https://github.com/erwinh22">erwinh22</a> &middot;
    <a href="https://github.com/whit3rabbit">whit3rabbit</a> &middot;
    <a href="https://github.com/skylaweber">skylaweber</a> &middot;
    <a href="https://github.com/PhucTruong-ctrl">PhucTruong-ctrl</a>
  </sub>
</p>



<p align="center">
  <sub>Anonymous usage data collected to improve the tool. No personal information ever.</sub>
</p>
