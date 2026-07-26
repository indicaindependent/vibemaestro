# Architecture

VibeMaestro is three planes that each do one job well, connected by signed sessions.

```
                      ┌────────────────────────────────────────────┐
   Discord OAuth ───▶ │  AUTH GATE  (Cloudflare Worker)             │
                      │  gate-worker.js                             │
                      │  · Discord login + guild-membership gating  │
                      │  · issues signed vm_sid session cookie      │
                      │  · /verify  ← every other service calls this│
                      └───────────────┬────────────────────────────┘
                                      │ session (vm_sid)
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
┌───────────────────┐      ┌───────────────────────┐     ┌──────────────────────┐
│  MODEL GATEWAY    │      │  STUDIO / APP WORKER   │     │  COMPUTE BRIDGE      │
│  gw-worker.js     │      │  (your front-end)      │     │  compute/bridge      │
│  · OpenAI-shaped  │      │  · serves the studio   │     │  · the ONLY public   │
│    /v1/chat       │◀─────│  · proxies build turns │────▶│    door to OpenCode  │
│  · per-user spend │      │    to the bridge       │     │  · injects OC pass   │
│    caps (AI GW)   │      └───────────────────────┘     │  · per-user session  │
│  · free-neuron    │                                     │    namespacing       │
│    fallback (~$0) │                                     └──────────┬───────────┘
└───────────────────┘                                                │ 127.0.0.1:4096
                                                          ┌──────────▼───────────┐
                                                          │  OpenCode (private)  │
                                                          │  password-gated,     │
                                                          │  never public        │
                                                          └──────────────────────┘

        Shared state:  D1 (users, sessions, invoices, agent packs, app records)
                       KV (session + OAuth-state store)
```

## The three planes

### 1. Auth gate — `workers/gate-worker.js`
Discord OAuth2 relay. Verifies the user is a member (in good standing) of an allowed
guild, mints a signed session, and exposes **`/verify`** so every other service can
authenticate a request without re-implementing auth. Also mints short-lived sessions
for trusted bots via a service-key endpoint (build-from-Discord flows).

### 2. Model gateway — `workers/gw-worker.js`
An OpenAI-shaped `POST /v1/chat/completions` proxy with the multi-tenant cost control
most projects get wrong:

- **Per-user daily spend caps**, enforced by Cloudflare AI Gateway (partitioned by user id).
- **Free tier** → Cloudflare Workers AI free-neuron model, ~$0, fully self-contained.
- **Paid tier** → DeepSeek default or Claude; users can bring their own key via header.
- **Graceful degradation** — a `429` (cap hit) transparently downgrades to the free model.

### 3. Compute bridge — `compute/bridge/server.js`  ← *our improved OpenCode fork*
This is the part worth stealing. [OpenCode](https://opencode.ai) is a superb coding agent,
but its server is **unauthenticated** (an RCE surface if exposed). VibeMaestro's bridge:

- Keeps OpenCode **private and password-gated** on `127.0.0.1:4096` — never public.
- Puts a thin, **session-verified** door in front of it (checks `vm_sid` against the gate).
- **Namespaces each user to their own OpenCode session** (derived from their Discord id) so
  users never see each other's workspaces.
- Injects the OpenCode password server-side, so the browser never holds it.
- Wires OpenCode to the **model gateway** as an OpenAI-compatible provider (`capy-pack/opencode.json`),
  so builds inherit the same spend caps and free-tier fallback as everything else.

The result: OpenCode's power, made safe for a multi-user, spend-capped, edge-fronted platform.

## Shared state (D1 + KV)

One D1 database backs everything — see [`d1/schema.sql`](../d1/schema.sql):

| Table | Purpose |
|---|---|
| `users` | tier, model preference, unlocks, spend accounting |
| `sessions` | active sessions (KV holds the hot copy) |
| `agent_packs` / `agent_memory` | per-user custom super-agents + their seeded memory |
| `invoices` | Lightning / billing records |
| `compute_sessions` | OpenCode workspace bookkeeping |
| `app_records` | published-app metadata (managed backend) |
| `config` | runtime knobs (allowed guild, budgets, standing roles) |

## Why it's shaped this way

Every AI app re-implements the same plumbing — model calls, auth, retries, rate limits —
and scatters keys across a dozen codebases. VibeMaestro centralizes the hard parts into
three guarded services so each app stays small, safe, and focused. Build the app; let the
maestro handle the orchestra.
