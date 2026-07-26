-- VibeMaestro core D1 schema v1 — Jul 8 2026
-- The single source of truth for users, membership, tiers, agents, payments.

-- ── Users (keyed by Discord user id) ────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  discord_id      TEXT PRIMARY KEY,
  username        TEXT,
  global_name     TEXT,
  avatar          TEXT,
  tier            TEXT NOT NULL DEFAULT 'free',      -- free | paid
  standing        TEXT NOT NULL DEFAULT 'good',      -- good | bad | unknown
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_login      TEXT,
  paid_until      TEXT,                              -- ISO datetime when paid tier lapses
  spend_today_usd REAL NOT NULL DEFAULT 0,           -- rolling, reset by day
  spend_day       TEXT,                              -- YYYY-MM-DD the spend_today belongs to
  suspended       INTEGER NOT NULL DEFAULT 0,        -- 1 = hard-blocked (abuse)
  notes           TEXT
);

-- ── Sessions (issued after Discord OAuth + standing check) ──────────
CREATE TABLE IF NOT EXISTS sessions (
  sid          TEXT PRIMARY KEY,                     -- random session id (also in KV)
  discord_id   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  ip           TEXT,
  ua           TEXT,
  FOREIGN KEY (discord_id) REFERENCES users(discord_id)
);

-- ── Agent packs (Capy = the default/system pack; paid users get their own) ──
CREATE TABLE IF NOT EXISTS agent_packs (
  id           TEXT PRIMARY KEY,                     -- pack id (uuid or slug)
  owner_id     TEXT,                                 -- NULL/system for Capy; discord_id for custom
  name         TEXT NOT NULL,                        -- display name of the agent
  slug         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'custom',       -- system | custom | community
  verified     INTEGER NOT NULL DEFAULT 0,           -- 1 = reviewed/safe (community gallery later)
  persona_md   TEXT,                                 -- the agents/*.md persona body
  agents_md    TEXT,                                 -- craft rules (AGENTS.md)
  opencode_json TEXT,                                -- model tier / gateway / caps / perms
  r2_key       TEXT,                                 -- packed tarball in R2
  version      TEXT NOT NULL DEFAULT '1.0.0',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Capy persistent memory (per-user, "more magic" — Pete approved) ─
CREATE TABLE IF NOT EXISTS agent_memory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id   TEXT NOT NULL,
  pack_id      TEXT NOT NULL,                        -- which agent this memory belongs to
  kind         TEXT NOT NULL DEFAULT 'note',         -- note | preference | project | fact
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (discord_id) REFERENCES users(discord_id)
);
CREATE INDEX IF NOT EXISTS idx_mem_user ON agent_memory(discord_id, pack_id);

-- ── Lightning invoices / subscriptions ──────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  payment_hash TEXT PRIMARY KEY,                     -- LN payment hash
  discord_id   TEXT NOT NULL,
  bolt11       TEXT NOT NULL,
  amount_sats  INTEGER NOT NULL,
  plan         TEXT NOT NULL,                        -- day | month | year
  status       TEXT NOT NULL DEFAULT 'pending',      -- pending | paid | expired
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at      TEXT,
  grants_until TEXT                                  -- what paid_until becomes on settle
);
CREATE INDEX IF NOT EXISTS idx_inv_user ON invoices(discord_id);

-- ── Fly compute sessions (track machines for cost control) ──────────
CREATE TABLE IF NOT EXISTS compute_sessions (
  id           TEXT PRIMARY KEY,
  discord_id   TEXT NOT NULL,
  fly_machine  TEXT,
  status       TEXT NOT NULL DEFAULT 'starting',     -- starting | running | suspended | stopped
  pack_id      TEXT,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_active  TEXT,
  stopped_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_compute_user ON compute_sessions(discord_id);

-- ── Config (single-row key/value, e.g. active guild id, bad-standing roles) ──
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO config (key, value) VALUES
  ('active_guild_id', ''),                            -- set to your Discord guild id (empty = open/any member)
  ('bad_standing_roles', '[]'),                       -- JSON array of role ids that = denied
  ('free_daily_budget_usd', '0.05'),                  -- micro-budget then free-neuron fallback
  ('paid_daily_budget_usd', '3.00');

-- ── P5: Managed backend for published apps (Jul 8 2026) ──────────────
CREATE TABLE IF NOT EXISTS app_records (
  id          TEXT PRIMARY KEY,
  subdomain   TEXT NOT NULL,
  collection  TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rec ON app_records(subdomain, collection, created_at);
CREATE INDEX IF NOT EXISTS idx_rec_coll ON app_records(subdomain, collection);
