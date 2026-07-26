#!/usr/bin/env bash
# ── VibeMaestro one-shot bootstrap ──────────────────────────────────────────
# Creates the D1 database + KV namespace, applies the schema, and prints the
# ids you need to drop into workers/wrangler.*.toml. Idempotent-ish; safe to re-read.
set -euo pipefail

command -v wrangler >/dev/null || { echo "Install wrangler first:  npm i -g wrangler"; exit 1; }

echo "▸ Creating D1 database 'vibemaestro'…"
wrangler d1 create vibemaestro || echo "  (already exists — continuing)"

echo "▸ Applying schema…"
wrangler d1 execute vibemaestro --file=d1/schema.sql --remote

echo "▸ Creating KV namespace 'SESSIONS'…"
wrangler kv namespace create SESSIONS || echo "  (already exists — continuing)"

cat <<'NEXT'

──────────────────────────────────────────────────────────────────────────
✔ Next steps
  1. Copy the D1 database_id and KV id printed above into:
       workers/wrangler.gate.toml   (DB + SESSIONS)
       workers/wrangler.gw.toml     (DB)
  2. Set secrets for each worker (see .env.example for the full list), e.g.:
       wrangler secret put DISCORD_CLIENT_ID   --config workers/wrangler.gate.toml
       wrangler secret put SESSION_SIGNING_KEY  --config workers/wrangler.gate.toml
       wrangler secret put CF_ACCOUNT_ID        --config workers/wrangler.gw.toml
  3. Deploy the edge:
       wrangler deploy --config workers/wrangler.gate.toml
       wrangler deploy --config workers/wrangler.gw.toml
  4. Build & deploy the compute plane (OpenCode bridge):
       see docs/DEPLOY.md  (Fly.io — fly launch inside compute/)
  5. In the Discord Developer Portal, add  <gate>/callback  as an OAuth2 redirect.

  Full walkthrough:  docs/DEPLOY.md
──────────────────────────────────────────────────────────────────────────
NEXT
