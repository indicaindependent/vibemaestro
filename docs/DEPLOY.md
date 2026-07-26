# Self-host guide

Stand up your own VibeMaestro in ~30 minutes. You need a **Cloudflare** account (Workers,
D1, KV, AI Gateway — all have free tiers) and a **Fly.io** account for the compute plane.
A **Discord application** provides login.

## 0. Prerequisites

```bash
npm i -g wrangler          # Cloudflare CLI
curl -L https://fly.io/install.sh | sh   # Fly CLI (for the compute plane)
cp .env.example .dev.vars  # then fill in real values locally
```

Create a Discord application at <https://discord.com/developers/applications>:
- OAuth2 → note the **Client ID** + **Client Secret**.
- Bot → create a bot, note the **Bot Token** (used to read member roles for standing).
- OAuth2 → Redirects → you'll add `<gate>/callback` after step 2.

## 1. Database + KV

```bash
./scripts/setup.sh
```

This creates the `vibemaestro` D1 database, applies [`d1/schema.sql`](../d1/schema.sql),
and creates the `SESSIONS` KV namespace. Copy the printed `database_id` + KV `id` into
`workers/wrangler.gate.toml` and `workers/wrangler.gw.toml`.

## 2. Auth gate

```bash
cd workers
wrangler secret put DISCORD_CLIENT_ID     --config wrangler.gate.toml
wrangler secret put DISCORD_CLIENT_SECRET --config wrangler.gate.toml
wrangler secret put DISCORD_BOT_TOKEN     --config wrangler.gate.toml
wrangler secret put SESSION_SIGNING_KEY   --config wrangler.gate.toml   # any random 32-byte hex
wrangler secret put BOT_SERVICE_KEY       --config wrangler.gate.toml
wrangler secret put OWNER_DISCORD_ID      --config wrangler.gate.toml   # your id — always approved
wrangler deploy --config wrangler.gate.toml
```

Now add `https://<your-gate-worker>/callback` as an OAuth2 redirect in Discord, set
`REDIRECT_URI` + `APP_URL` in `wrangler.gate.toml`, and point `active_guild_id` at your server:

```bash
wrangler d1 execute vibemaestro --remote --command \
  "UPDATE config SET value='YOUR_GUILD_ID' WHERE key='active_guild_id'"
```

(Leave it empty to allow any Discord user — handy for testing.)

## 3. Model gateway

Create a **Cloudflare AI Gateway** in the dashboard (enable logging; add a per-user spend
rule partitioned by `metadata.user_id`, plus a global safety cap). Then:

```bash
wrangler secret put CF_ACCOUNT_ID   --config wrangler.gw.toml
wrangler secret put DEEPSEEK_API_KEY --config wrangler.gw.toml   # optional (paid default)
wrangler secret put VM_ANTHROPIC_KEY --config wrangler.gw.toml   # optional (platform Claude)
# set AIG_SLUG + GATE_URL in wrangler.gw.toml, then:
wrangler deploy --config wrangler.gw.toml
```

The free tier works with **no** paid keys — it falls back to a Cloudflare Workers AI
free-neuron model.

## 4. Compute plane (the OpenCode bridge)

The bridge + OpenCode run together in one Fly machine. **Give it at least 2 GB RAM** —
OpenCode OOM-kills under 1 GB.

```bash
cd ../compute
fly launch --no-deploy          # name it, e.g. your-compute-app
fly secrets set \
  OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 24) \
  BRIDGE_SHARED_SECRET=$(openssl rand -hex 24) \
  GATE_URL=https://<your-gate-worker>
fly deploy --remote-only
```

Then point your studio/app worker's build lane at `https://<your-compute-app>` with the
`BRIDGE_SHARED_SECRET` header. The bridge verifies each request's `vm_sid` against the gate
before it ever touches OpenCode.

> **Security note.** OpenCode's server is unauthenticated by design. **Never** expose port
> 4096 publicly. The bridge is the only public door, and it is session-gated. This starter
> is wired that way out of the box — keep it that way.

## 5. Front-end

This starter ships the three backend planes. Bring your own studio UI (or fork ours) and:
1. Redirect unauthenticated users to `https://<gate>/login`.
2. Send chat/build requests to the gateway (`/v1/chat/completions`) with the `vm_sid` cookie.
3. Proxy build turns to the compute bridge with the shared secret.

That's the whole platform: **login → orchestrate → build**, with secrets server-side and
spend capped per user.
