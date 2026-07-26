# VibeMaestro

> **Your apps, orchestrated. One conductor for a whole ecosystem of AI-native tools.**

<p align="center">
  <img src="https://img.shields.io/badge/status-open%20source-brightgreen?style=for-the-badge" alt="Status: Open Source"/>
  <img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="License: MIT"/>
  <img src="https://img.shields.io/badge/edge-Cloudflare%20Workers-f38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"/>
  <img src="https://img.shields.io/badge/agent-OpenCode%20(hardened)-8b7bff?style=for-the-badge" alt="OpenCode, hardened"/>
</p>

**Live:** [vibemaestro.app](https://vibemaestro.app) · Built and maintained by **[VPDLNY](https://github.com/vpdlny)**.

---

This is a **generic, self-hostable starting point** for building your own vibe-coding
platform — with an advanced backend already in place. We forked [OpenCode](https://opencode.ai),
hardened it for multi-user production, and wrapped it in the orchestration layer we run in
production. Fork this, add your own front-end, and you have a real platform on day one instead
of month three.

No black boxes. No lock-in. Every value is a placeholder — bring your own keys.

## What you get

- 🎼 **A model gateway** — one OpenAI-shaped endpoint for every app, with **per-user spend caps** and a **free-tier fallback that costs ~$0**.
- 🔐 **A Discord-OAuth auth gate** — membership-gated login + a single `/verify` other services call. Branded, self-contained, zero external deps.
- ⚙️ **A hardened OpenCode compute plane** — OpenCode is a superb coding agent but its server is *unauthenticated*. Our bridge keeps it private, session-gates it, and **namespaces each user to their own workspace**.
- 🗄️ **A ready schema** — D1 tables for users, sessions, custom agents + memory, invoices, published apps.
- 🧠 **A craftsmanship-tuned agent pack** — `capy-pack` ships opinionated build rules ("ship real working code, never a placeholder") wired straight into OpenCode.

## What it isn't

- ❌ Not another chatbot wrapper
- ❌ Not a walled garden — MIT, fork it freely
- ❌ Not tied to a single model vendor
- ❌ Not a data-harvesting funnel — secrets stay server-side

## The three planes

| Plane | File | Job |
|---|---|---|
| **Auth gate** | `workers/gate-worker.js` | Discord login, membership gating, session `/verify` |
| **Model gateway** | `workers/gw-worker.js` | OpenAI-shaped chat proxy, per-user spend caps, free fallback |
| **Compute bridge** | `compute/bridge/server.js` | The only public, session-gated door to a private OpenCode |

Full picture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Why the OpenCode fork matters

Plain OpenCode exposes an unauthenticated server — fine for your laptop, a liability for a
multi-user platform. VibeMaestro's bridge is the fix:

- OpenCode stays **private + password-gated** on `127.0.0.1:4096`, never public.
- Every request is **verified against the auth gate** before it reaches the agent.
- Each user gets **their own OpenCode session**, derived from their Discord id — no cross-talk.
- OpenCode is wired to the **model gateway** as an OpenAI-compatible provider, so builds
  inherit the same spend caps and free-tier fallback as everything else.

You get OpenCode's power, made safe for production.

## Quick start

```bash
git clone https://github.com/indicaindependent/vibemaestro.git
cd vibemaestro
cp .env.example .dev.vars      # fill in real values
./scripts/setup.sh            # creates D1 + KV, applies schema
```

Then follow [`docs/DEPLOY.md`](docs/DEPLOY.md) to deploy the gate, the gateway, and the
compute plane. You need a Cloudflare account (Workers/D1/KV/AI Gateway — all free-tier),
a Fly.io account (compute), and a Discord app (login). ~30 minutes end to end.

## Layout

```
vibemaestro/
├── workers/
│   ├── gate-worker.js        # auth gate (Discord OAuth + sessions)
│   ├── gw-worker.js          # model gateway (spend caps + free fallback)
│   └── wrangler.*.toml       # per-worker deploy config
├── compute/
│   ├── bridge/server.js      # hardened OpenCode bridge  ← the fork
│   ├── capy-pack/            # OpenCode agent config + craft rules
│   ├── Dockerfile / fly.toml # compute-plane image
│   └── entrypoint.sh
├── d1/schema.sql             # the whole database
├── scripts/setup.sh          # one-shot bootstrap
├── docs/ARCHITECTURE.md      # how the planes fit together
├── docs/DEPLOY.md            # self-host walkthrough
└── .env.example              # the full binding contract (all placeholders)
```

## Security

- Every secret is an environment binding — **nothing real is committed**. See `.env.example`.
- The OpenCode server is **never** exposed; only the session-gated bridge is public.
- Model credentials live in the gateway; apps only ever hold a scoped session.
- Run a secret scan before you push your fork. `.gitignore` already blocks the usual offenders.

## Philosophy

VibeMaestro is part of the **VPDLNY** mission — free, independent, open tooling with no VC,
no boss, no strings. The code lives in the open because it should.

<p align="center">
  <sub>Built by <a href="https://osintnet.uk">Indica Independent</a> · <a href="https://github.com/vpdlny">VPDLNY</a> · info is the weapon ⚔️</sub>
</p>

---

## ⚡ Support the Mission

Free, ad-free, independent infrastructure — no VC, no gov funding, no strings. If it served
you, a tip keeps it alive and funds the next tool.

[![Donate via SkyGive](https://img.shields.io/badge/💜_Donate_via_SkyGive-8A5CF6?style=for-the-badge&logoColor=white)](https://donate.skygive.app/)
[![Lightning](https://img.shields.io/badge/⚡_tips@skygive.app-F7931A?style=for-the-badge&logo=lightning&logoColor=white)](https://donate.skygive.app/)

<sub>🧡 Sovereign Lightning + on-chain via SkyGive. Your sats fund uptime, not ads.</sub>
