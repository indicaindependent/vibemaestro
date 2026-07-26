/**
 * VibeMaestro — gw.example.com
 * The model proxy. Session-guarded. Tags every request with metadata.user_id so the
 * AI Gateway per-user spend cap applies per person. Routes free vs paid to the right tier.
 *
 * Free users  → CF Workers AI free-neuron model (Kimi/Qwen) = ~$0, OR a micro-budget of DeepSeek.
 * Paid users  → DeepSeek default, BYO-Claude if they supplied a key, higher cap.
 *
 * Bindings: DB (D1), AI (Workers AI binding), plus fetch to AI Gateway.
 * Secrets: CF_ACCOUNT_ID, AIG_SLUG (vibemaestro), DEEPSEEK_API_KEY (platform key for paid default)
 * Vars: GATE_URL (https://gate.example.com)
 *
 * Jul 9 2026 — RESEARCH INJECTION (free tier): the free model (Qwen-coder) hallucinates on
 * unknown real-world facts and cannot emit clean structured tool-calls, so we do the research
 * SERVER-SIDE here (Wikipedia REST → DuckDuckGo fallback), deterministically, and inject a
 * "RESEARCHED FACTS" system message before the model call. Guarded: 1 lookup/turn, private-IP
 * deny (only our fixed keyless endpoints are ever hit), size-capped. Paid tier keeps true
 * agentic tool-use via the strong model, so this only augments the weak free path.
 */

const UA = "Mozilla/5.0 (VibeMaestro/1.0; +https://example.com)";

// Free-tier fallback model (runs on CF Workers AI free neuron allocation)
const FREE_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
// Paid default (cheap & capable) via DeepSeek through the gateway
const PAID_DEFAULT_PROVIDER = "deepseek";
const PAID_DEFAULT_MODEL = "deepseek-chat";

// ─── MODEL PLANE (P5, Jul 14 2026) ───────────────────────────────────────────
// We bring OUR Anthropic key (VM_ANTHROPIC_KEY). End users NEVER supply a key.
// Paid users get ONE toggle: DeepSeek <-> Claude. Which Claude model = admin-set
// per user via `model_unlocks`; default paid-Claude = Sonnet 5 (the workhorse).
// Premium models (Opus 4.8 / Fable 5) are admin-unlock-only per user.
const CLAUDE = {
  standard: "claude-sonnet-5",          // default paid-Claude workhorse (always allowed on paid)
  fast:     "claude-haiku-4-5-20251001",// cheap internal / quick tasks
  premium:  { "claude-opus-4-8": 1, "claude-fable-5": 1, "claude-opus-4-7": 1, "claude-sonnet-4-6": 1 },
};
// A requested Claude model is allowed if it's the standard/fast OR present in the user's unlocks.
function pickClaudeModel(requested, unlocks) {
  const allowUnlocked = Array.isArray(unlocks) ? unlocks : [];
  if (!requested) return CLAUDE.standard;
  if (requested === CLAUDE.standard || requested === CLAUDE.fast) return requested;
  if (CLAUDE.premium[requested] && allowUnlocked.includes(requested)) return requested;
  return CLAUDE.standard; // silently fall back to Sonnet 5 if they ask for a locked premium model
}
function parseUnlocks(raw) { try { const a=JSON.parse(raw||"[]"); return Array.isArray(a)?a:[]; } catch { return []; } }

// Anthropic key resolver: admin-rotatable via D1 platform_config.anthropic_api_key,
// falling back to the VM_ANTHROPIC_KEY secret. Cached in-isolate for 60s to avoid a D1 hit per call.
let _akCache = { val: null, exp: 0 };
async function resolveAnthropicKey(env) {
  const now = Date.now();
  if (_akCache.val && now < _akCache.exp) return _akCache.val;
  let key = env.VM_ANTHROPIC_KEY || null;
  try {
    const row = await env.DB.prepare("SELECT v FROM platform_config WHERE k='anthropic_api_key'").first();
    if (row && row.v && row.v.trim()) key = row.v.trim();
  } catch {}
  _akCache = { val: key, exp: now + 60000 };
  return key;
}

// --- Per-user usage caps (malicious credit-burn hardening) ---
const FREE_DAILY_CAP  = Number(globalThis.FREE_DAILY_CAP  || 100);
const PAID_DAILY_CAP  = Number(globalThis.PAID_DAILY_CAP  || 500);
const BURST_PER_MIN   = 20;

// ─────────────────────────────────────────────────────────────────────────────
// RESEARCH INJECTION (free tier anti-hallucination) — Jul 9 2026
// ─────────────────────────────────────────────────────────────────────────────

// Doctrine reinforced at the model layer (belt + suspenders with capy.md / AGENTS.md).
const CAPY_DOCTRINE =
  "You are Capy, VibeMaestro's build agent. Craft rules you MUST obey:\n" +
  "• NEVER leave placeholders or fake data. If you don't know a real-world fact, USE the " +
  "RESEARCHED FACTS provided below — never invent a person, product, API, or statistic.\n" +
  "• PREFER embedding researched real data as inline static JSON/HTML over inventing an external " +
  "API. Only wire a live API if the user names one or it's a known keyless public endpoint.\n" +
  "• Resolve gaps yourself: at most one clarifying question, then make the best defensible " +
  "assumption and BUILD working code. State the assumption in one line.\n" +
  "• Verify before you finish: no fetch() to a placeholder/unresolvable URL; referenced files " +
  "exist; real seed data is present; trace the happy path so the preview renders without error.\n" +
  "• You are the geeky friend with the inside scoop — real research, real facts, real running code.";

// Heuristic: does this turn need real-world facts the weak model likely doesn't have?
function needsResearch(text) {
  if (!text || text.length < 4) return null;
  const t = text.toLowerCase();
  // trigger phrases
  const triggers = [
    /\bwho\s+is\b/, /\bwhat\s+is\b/, /\bdeep\s*dive\b/, /\blook\s*up\b/, /\bresearch\b/,
    /\bpopulate\b.*\b(real|actual|correct|accurate)\b/, /\breal\s+(data|assets|content|info)/,
    /\babout\b.*\b(the|this)\b.*\b(person|company|brand|product|show|movie|band|character|candidate)\b/,
  ];
  if (!triggers.some((re) => re.test(t))) return null;
  // Extract a probable subject: prefer a quoted phrase, else Capitalized proper-noun run.
  let subj = (text.match(/["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]/) || [])[1];
  if (!subj) {
    const caps = text.match(/\b([A-Z][a-zA-Z0-9.&-]+(?:\s+[A-Z][a-zA-Z0-9.&-]+){0,3})\b/g) || [];
    // skip leading sentence-start words; pick the longest capitalized run
    subj = caps.sort((a, b) => b.length - a.length)[0];
  }
  if (!subj) return null;
  subj = subj.trim().replace(/[.?!,]+$/, "");
  if (subj.length < 2 || subj.length > 80) return null;
  return subj;
}

async function fetchWithTimeout(u, opts, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || 6000);
  try { return await fetch(u, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(to); }
}

// Deterministic, keyless research. Wikipedia REST summary first (great for "who/what is X"),
// DuckDuckGo Instant Answer as fallback. Returns a short fact string or null. Size-capped.
async function doResearch(subject) {
  const headers = { "user-agent": UA, accept: "application/json" };
  // 1) Wikipedia REST summary
  try {
    const wu = "https://en.wikipedia.org/api/rest_v1/page/summary/" +
      encodeURIComponent(subject.replace(/\s+/g, "_"));
    const r = await fetchWithTimeout(wu, { headers }, 6000);
    if (r.ok) {
      const d = await r.json();
      const extract = (d.extract || "").trim();
      if (extract && d.type !== "disambiguation" && extract.length > 40) {
        return { source: "Wikipedia", title: d.title || subject, fact: extract.slice(0, 600) };
      }
    }
  } catch (_) { /* fall through */ }
  // 2) DuckDuckGo Instant Answer
  try {
    const du = "https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" +
      encodeURIComponent(subject);
    const r = await fetchWithTimeout(du, { headers }, 6000);
    if (r.ok) {
      const d = await r.json();
      const abs = (d.AbstractText || d.Answer || "").trim();
      if (abs && abs.length > 30) {
        return { source: d.AbstractSource || "DuckDuckGo", title: d.Heading || subject, fact: abs.slice(0, 600) };
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

// Prepend a RESEARCHED FACTS system message (+ doctrine) to the messages array.
async function withResearch(messages) {
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  // last user turn drives the research
  const lastUser = [...msgs].reverse().find((m) => m && m.role === "user");
  const subject = lastUser ? needsResearch(typeof lastUser.content === "string" ? lastUser.content : "") : null;
  let researchNote = "";
  let researched = null;
  if (subject) {
    researched = await doResearch(subject).catch(() => null);
    if (researched) {
      researchNote =
        "\n\nRESEARCHED FACTS (verified, use these — do NOT invent):\n" +
        "• Subject: " + researched.title + "\n" +
        "• " + researched.fact + "\n" +
        "• Source: " + researched.source + "\n" +
        "Build the app using these real facts. If the user asked to 'populate' an app, embed this " +
        "as real inline content — do NOT fetch a placeholder API.";
    }
  }
  const sys = { role: "system", content: CAPY_DOCTRINE + researchNote };
  // merge with an existing leading system message if present
  if (msgs[0] && msgs[0].role === "system") {
    msgs[0] = { role: "system", content: sys.content + "\n\n---\n" + msgs[0].content };
  } else {
    msgs.unshift(sys);
  }
  return { messages: msgs, researched: !!researched, subject: subject || null };
}

function utcDay()    { return new Date().toISOString().slice(0, 10); }
function utcMinute() { return new Date().toISOString().slice(0, 16); }

async function checkAndBumpUsage(env, discord_id, tier) {
  const dailyCap = tier === "paid" ? PAID_DAILY_CAP : FREE_DAILY_CAP;
  const day = utcDay();
  const minute = utcMinute();

  await env.DB.prepare(
    "INSERT INTO usage_minute (discord_id, minute, count) VALUES (?1, ?2, 1) " +
    "ON CONFLICT(discord_id, minute) DO UPDATE SET count = count + 1"
  ).bind(discord_id, minute).run();
  const mrow = await env.DB.prepare(
    "SELECT count FROM usage_minute WHERE discord_id=?1 AND minute=?2"
  ).bind(discord_id, minute).first();
  const minCount = (mrow && mrow.count) || 0;
  if (minCount > BURST_PER_MIN) {
    return { ok: false, reason: "burst", min_count: minCount, cap: BURST_PER_MIN };
  }

  await env.DB.prepare(
    "INSERT INTO usage_daily (discord_id, day, count) VALUES (?1, ?2, 1) " +
    "ON CONFLICT(discord_id, day) DO UPDATE SET count = count + 1"
  ).bind(discord_id, day).run();
  const drow = await env.DB.prepare(
    "SELECT count FROM usage_daily WHERE discord_id=?1 AND day=?2"
  ).bind(discord_id, day).first();
  const dayCount = (drow && drow.count) || 0;
  if (dayCount > dailyCap) {
    return { ok: false, reason: "daily", day_count: dayCount, cap: dailyCap };
  }

  return { ok: true, day_count: dayCount, min_count: minCount, cap: dailyCap };
}

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
}

async function verifySession(request, env) {
  const sid =
    (request.headers.get("cookie") || "").match(/vm_sid=([a-f0-9]+)/)?.[1] ||
    request.headers.get("x-vm-sid") ||
    (request.headers.get("authorization") || "").match(/^Bearer\s+([a-f0-9]{8,})$/i)?.[1];
  if (!sid) return null;
  const res = await fetch(`${env.GATE_URL}/verify?sid=${sid}`, { headers: { "user-agent": UA } });
  if (!res.ok) return null;
  const d = await res.json();
  return d.ok ? d.session : null;
}

async function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* ─────────────────────────────────────────────────────────────
 * VibeMaestro Observability Module  (canonical source — Jul 9 2026)
 * Injected into each worker. Tiers:
 *  1. Structured JSON console logging (CF Observability captures it)
 *  2. Error sink → D1 error_log (via waitUntil, non-blocking)
 *  3. Telegram alert on real errors (rate-limited, PII-safe)
 *
 * USAGE inside a worker's fetch:
 *   const obs = makeObs(env, ctx, "vibemaestro-app");
 *   obs.log("info", "req", { path });
 *   ... try { ... } catch (e) { obs.error("build_failed", e, { path, sid }); }
 *   return obs.wrap(async () => { ...handler... }, request);   // top-level guard
 *
 * SAFETY: never logs secrets; discord ids are sha-256 hashed to sid_hash.
 * ───────────────────────────────────────────────────────────── */
function makeObs(env, ctx, worker) {
  const now = () => Date.now();
  async function hash(s) {
    if (!s) return null;
    try {
      const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
      return [...new Uint8Array(b)].slice(0, 6).map((x) => x.toString(16).padStart(2, "0")).join("");
    } catch { return null; }
  }
  // redact anything that smells like a secret from meta
  function clean(meta) {
    if (!meta || typeof meta !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(meta)) {
      if (/secret|token|pass|auth|key|bearer|cookie/i.test(k)) { out[k] = "[redacted]"; continue; }
      if (typeof v === "string" && v.length > 300) { out[k] = v.slice(0, 300) + "…"; continue; }
      out[k] = v;
    }
    return out;
  }
  function line(level, event, meta) {
    const rec = { ts: now(), worker, level, event, ...clean(meta) };
    try { console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](JSON.stringify(rec)); } catch {}
    return rec;
  }
  async function sinkD1(rec) {
    if (!env.DB) return;
    try {
      await env.DB.prepare(
        "INSERT INTO error_log (ts,worker,level,event,msg,status,path,sid_hash,meta) VALUES (?,?,?,?,?,?,?,?,?)"
      ).bind(
        rec.ts, worker, rec.level, rec.event || null, (rec.msg || "").slice(0, 500) || null,
        rec.status || null, rec.path || null, rec.sid_hash || null,
        JSON.stringify(clean(rec.meta || {})).slice(0, 1000)
      ).run();
    } catch (_) {}
  }
  // rate-limited telegram alert (KV throttle if available; else best-effort)
  async function alert(rec) {
    const tok = env.SCRAMBLEMEBOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
    const chat = env.TELEGRAM_PETE_ID || "8670117195";
    if (!tok) return;
    try {
      if (env.SESSIONS || env.KV || env.WC) {
        const kv = env.SESSIONS || env.KV || env.WC;
        const key = `obserr:${worker}:${rec.event || "err"}`;
        if (await kv.get(key)) return;                // throttled (1 alert / 10 min / event)
        ctx && ctx.waitUntil(kv.put(key, "1", { expirationTtl: 600 }));
      }
      const txt = `⚠️ <b>VibeMaestro error</b>\n<code>${worker}</code> · ${rec.event || "error"}` +
        (rec.status ? ` · ${rec.status}` : "") + (rec.path ? `\n${rec.path}` : "") +
        (rec.msg ? `\n<i>${(rec.msg || "").slice(0, 180)}</i>` : "");
      await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: txt, parse_mode: "HTML", disable_web_page_preview: true }),
      });
    } catch (_) {}
  }
  return {
    log: (level, event, meta) => line(level, event, meta),
    async error(event, err, meta = {}) {
      const rec = line("error", event, { ...meta, msg: err && (err.stack || err.message || String(err)) });
      rec.msg = err && (err.message || String(err));
      if (ctx) ctx.waitUntil(Promise.all([sinkD1(rec), alert(rec)]));
      else { sinkD1(rec); alert(rec); }
      return rec;
    },
    hash,
    // top-level guard: any thrown error → logged + sunk + alerted, returns 500 JSON
    async wrap(handler, request) {
      const t0 = now();
      try {
        const res = await handler();
        const ms = now() - t0;
        if (res && res.status >= 500) {
          const rec = line("error", "http_5xx", { status: res.status, path: request && new URL(request.url).pathname, ms });
          if (ctx) ctx.waitUntil(Promise.all([sinkD1(rec), alert(rec)]));
        }
        return res;
      } catch (e) {
        const path = request ? new URL(request.url).pathname : null;
        const rec = line("error", "unhandled", { msg: e && (e.stack || String(e)), path, ms: now() - t0 });
        rec.msg = e && (e.message || String(e));
        if (ctx) ctx.waitUntil(Promise.all([sinkD1(rec), alert(rec)]));
        return new Response(JSON.stringify({ error: "internal", ref: rec.ts }), { status: 500, headers: { "content-type": "application/json" } });
      }
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const obs = makeObs(env, ctx, "vibemaestro-gw");
    return obs.wrap(async () => {
    const url = new URL(request.url);
    if (url.pathname === "/_diag") {
      let cnt = null; try { cnt = await env.DB.prepare("SELECT COUNT(*) c, MAX(ts) last FROM error_log WHERE worker=? AND ts > ?").bind("vibemaestro-gw", Date.now()-86400000).first(); } catch (e) {}
      return new Response(JSON.stringify({ ok:true, worker:"vibemaestro-gw", ts:Date.now(), errors_24h:cnt }), { headers:{"content-type":"application/json"} });
    }

    if (url.pathname === "/health") return json({ ok: true, service: "gw" });

    // Usage / budget read-back: tells the user their tier, standing, and daily cap.
    if (url.pathname === "/v1/usage" || url.pathname === "/usage") {
      const s = await verifySession(request, env);
      if (!s) return json({ error: "unauthorized" }, 401);
      const row = await env.DB.prepare(
        "SELECT tier, suspended, model_pref, model_unlocks, boost_day, boost_used FROM users WHERE discord_id=?"
      ).bind(s.discord_id).first();
      if (!row) return json({ error: "no user" }, 403);
      const tier = row.tier || "free";
      const caps = {
        free: { model: "capy-free (CF Workers AI)", daily_usd_cap: 0, marginal_cost: "$0 (free neurons)", daily_prompt_cap: FREE_DAILY_CAP, burst_per_min: BURST_PER_MIN },
        paid: { model: "deepseek (via AI Gateway)", daily_usd_cap: Number(env.PAID_DAILY_CAP_USD || 3), marginal_cost: "metered to platform balance", daily_prompt_cap: PAID_DAILY_CAP, burst_per_min: BURST_PER_MIN },
      };
      const today = new Date().toISOString().slice(0, 10);
      const boostAvail = tier === "free" ? ((row.boost_day === today ? (Number(row.boost_used) || 0) : 0) < 1) : null;
      return json({
        ok: true,
        discord_id: s.discord_id,
        tier,
        suspended: !!row.suspended,
        model_pref: (row.model_pref || "deepseek"),
        model_unlocks: parseUnlocks(row.model_unlocks),
        claude_default: CLAUDE.standard,
        boost_available: boostAvail,
        ...(caps[tier] || caps.free),
        note: "Per-user spend cap enforced by Cloudflare AI Gateway. 402/429 gracefully downgrades to the free model.",
      });
    }


    // Only the chat/completions proxy path is exposed
    if (!["/v1/chat/completions", "/chat/completions", "/chat"].includes(url.pathname)) {
      return json({ error: "not found" }, 404);
    }

    // 1) auth
    const sess = await verifySession(request, env);
    if (!sess) return json({ error: "unauthorized" }, 401);

    // 2) load user tier + suspension
    const u = await env.DB.prepare(
      "SELECT tier, suspended, model_pref, model_unlocks, boost_day, boost_used FROM users WHERE discord_id=?"
    ).bind(sess.discord_id).first();
    if (!u) return json({ error: "no user" }, 403);
    if (u.suspended) return json({ error: "suspended" }, 403);

    const tier = u.tier || "free";
    const body = await request.json().catch(() => ({}));

    // --- USAGE CAP ENFORCEMENT (per-user daily + burst) ---
    const usage = await checkAndBumpUsage(env, sess.discord_id, tier).catch((e) => ({ ok: true, soft_error: String(e) }));
    if (!usage.ok) {
      if (usage.reason === "burst") {
        return json({
          error: "rate_limited",
          detail: "You're sending prompts too fast. Give it a few seconds and try again.",
          retry_after: 30,
        }, 429);
      }
      const upgradeMsg = tier === "paid"
        ? "You've hit today's usage ceiling. It resets at midnight UTC."
        : "You've reached the free daily limit of " + usage.cap + " prompts. It resets at midnight UTC — or upgrade for a much higher ceiling.";
      return json({
        error: "daily_limit_reached",
        detail: upgradeMsg,
        tier, used: usage.day_count, cap: usage.cap, resets: "00:00 UTC",
      }, 429);
    }

    // 3) FREE tier → CF Workers AI free-neuron model (never bills marginal $)
    if (tier === "free") {
      // 3a) DAILY DEEPSEEK BOOST — one free DeepSeek build/day so free users taste paid quality.
      // Client requests it with {boost:true}. Consumed atomically per UTC day.
      if (body.boost === true) {
        const today = new Date().toISOString().slice(0, 10);
        const usedToday = (u.boost_day === today) ? (Number(u.boost_used) || 0) : 0;
        if (usedToday < 1) {
          // consume the boost first (so a failure can't be replayed for free spend)
          await env.DB.prepare("UPDATE users SET boost_day=?, boost_used=? WHERE discord_id=?")
            .bind(today, usedToday + 1, sess.discord_id).run().catch(() => {});
          const acct = env.CF_ACCOUNT_ID, slug = env.AIG_SLUG || "your-gateway-slug";
          const bBody = JSON.stringify({
            model: PAID_DEFAULT_MODEL,
            max_tokens: Math.min(body.max_tokens || 2048, 4096),
            messages: body.messages || [{ role: "user", content: body.prompt || "" }],
            stream: !!body.stream,
          });
          const bUp = await fetch(`https://gateway.ai.cloudflare.com/v1/${acct}/${slug}/deepseek/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
              "cf-aig-metadata": JSON.stringify({ user_id: sess.discord_id, tier: "free", boost: true }),
              "user-agent": UA,
            },
            body: bBody,
          });
          if (bUp.ok) {
            if (body.stream && bUp.body) {
              return new Response(bUp.body, { status: bUp.status, headers: { "content-type": bUp.headers.get("content-type") || "text/event-stream", "cache-control": "no-cache", "x-vm-provider": "deepseek-boost" } });
            }
            const bt = await bUp.text();
            return new Response(bt, { status: bUp.status, headers: { "content-type": bUp.headers.get("content-type") || "application/json", "x-vm-provider": "deepseek-boost" } });
          }
          // boost failed upstream (402/429/etc) → fall through to Qwen below (boost already consumed; that's ok — refund on non-402? keep simple: only refund on 402 platform-empty)
          if (bUp.status === 402) {
            await env.DB.prepare("UPDATE users SET boost_used=? WHERE discord_id=?").bind(usedToday, sess.discord_id).run().catch(() => {});
          }
        }
        // else: boost already used today → silently serve the normal free (Qwen) path below
      }
      try {
        // RESEARCH INJECTION: server-side lookup + doctrine, so the weak model builds on real facts.
        const baseMsgs = body.messages || [{ role: "user", content: body.prompt || "" }];
        const enriched = await withResearch(baseMsgs).catch(() => ({ messages: baseMsgs, researched: false, subject: null }));
        const out = await env.AI.run(FREE_MODEL, {
          messages: enriched.messages,
          max_tokens: Math.min(body.max_tokens || 1024, 2048),
        });
        const content = out?.response ?? out?.result?.response ?? (typeof out === "string" ? out : JSON.stringify(out));
        const id = "chatcmpl-vm-" + Date.now();
        const created = Math.floor(Date.now() / 1000);
        const model = body.model || "capy-free";

        // If the client asked for streaming (OpenCode's openai-compatible provider does),
        // emit an OpenAI-style SSE stream of chat.completion.chunk events.
        if (body.stream) {
          const enc = new TextEncoder();
          const chunk = (delta, finish) => "data: " + JSON.stringify({
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta, finish_reason: finish || null }],
          }) + "\n\n";
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(enc.encode(chunk({ role: "assistant" }, null)));
              controller.enqueue(enc.encode(chunk({ content }, null)));
              controller.enqueue(enc.encode(chunk({}, "stop")));
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "x-vm-researched": String(enriched.researched) },
          });
        }

        // Non-streaming: single OpenAI-compatible chat.completion.
        return json({
          id, object: "chat.completion", created, model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          vm_researched: enriched.researched, vm_subject: enriched.subject,
        });
      } catch (e) {
        return json({ error: "free model error", detail: String(e) }, 502);
      }
    }

    // 4) PAID tier → route through AI Gateway with per-user metadata tag
    // BYO-Claude if the user attached a key; else platform DeepSeek.
    // 4) PAID tier → route through AI Gateway with per-user metadata tag.
    // We bring OUR Anthropic key. User's `model_pref` = "claude" or "deepseek" (default).
    // A body.model override is honored only within what their tier/unlocks allow.
    const acct = env.CF_ACCOUNT_ID;
    const slug = env.AIG_SLUG || "your-gateway-slug";
    const modelPref = (u.model_pref || "deepseek").toLowerCase();
    const unlocks = parseUnlocks(u.model_unlocks);
    // decide provider: explicit body.provider wins, else the user's toggle
    const wantClaude = (body.provider === "anthropic") || (!body.provider && modelPref === "claude");
    const anthropicKey = await resolveAnthropicKey(env);

    let gwUrl, upstreamHeaders, upstreamBody, providerLabel, chosenModel;
    if (wantClaude && anthropicKey) {
      providerLabel = "anthropic";
      chosenModel = pickClaudeModel(body.model, unlocks);
      gwUrl = `https://gateway.ai.cloudflare.com/v1/${acct}/${slug}/anthropic/v1/messages`;
      upstreamHeaders = {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "cf-aig-metadata": JSON.stringify({ user_id: sess.discord_id, tier, model: chosenModel }),
        "user-agent": UA,
      };
      upstreamBody = JSON.stringify({
        model: chosenModel,
        max_tokens: Math.min(body.max_tokens || 2048, 8192),
        messages: body.messages || [{ role: "user", content: body.prompt || "" }],
        stream: !!body.stream,
      });
    } else {
      providerLabel = PAID_DEFAULT_PROVIDER;
      chosenModel = body.model && body.model.startsWith("deepseek") ? body.model : PAID_DEFAULT_MODEL;
      gwUrl = `https://gateway.ai.cloudflare.com/v1/${acct}/${slug}/deepseek/chat/completions`;
      upstreamHeaders = {
        "content-type": "application/json",
        authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        "cf-aig-metadata": JSON.stringify({ user_id: sess.discord_id, tier, model: chosenModel }),
        "user-agent": UA,
      };
      upstreamBody = JSON.stringify({
        model: chosenModel,
        max_tokens: Math.min(body.max_tokens || 2048, 8192),
        messages: body.messages || [{ role: "user", content: body.prompt || "" }],
        stream: !!body.stream,
      });
    }

    const upstream = await fetch(gwUrl, { method: "POST", headers: upstreamHeaders, body: upstreamBody });

    // 429 = user spend cap hit; 402 = platform balance empty → graceful downgrade to free model
    if (upstream.status === 429 || upstream.status === 402) {
      try {
        const out = await env.AI.run(FREE_MODEL, {
          messages: body.messages || [{ role: "user", content: body.prompt || "" }],
          max_tokens: Math.min(body.max_tokens || 1024, 2048),
        });
        return json({ tier: "paid", downgraded: true, reason: upstream.status === 402 ? "platform_balance" : "daily_cap", model: FREE_MODEL, result: out });
      } catch (e) {
        return json({ error: "cap reached and fallback failed", detail: String(e) }, 502);
      }
    }

    // Stream passthrough: for streaming requests, pipe the upstream SSE body straight through
    // so OpenCode's provider receives chat.completion.chunk events as they arrive.
    if (body.stream && upstream.ok && upstream.body) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") || "text/event-stream",
          "cache-control": "no-cache",
          "x-vm-provider": providerLabel,
        },
      });
    }
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json", "x-vm-provider": providerLabel },
    });
    }, request);
  },
};
