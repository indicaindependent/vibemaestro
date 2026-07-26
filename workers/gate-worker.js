const UA = "Mozilla/5.0 (VibeMaestro/1.0; +https://vibemaestro.app)";
const SCOPES = "identify guilds guilds.members.read";

async function cfg(env, key, dflt) {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key=?").bind(key).first();
  return row ? row.value : dflt;
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function randSid() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
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
/* ═══════════════════════════════════════════════════════════════
 * VM_GATE_UIUX_V1 — branded OAuth login experience (Jul 26 2026)
 * Self-contained HTML pages (no external deps), theme-matched to the
 * VibeMaestro studio (dark + gold). Replaces raw JSON/302 dead-ends.
 * ═══════════════════════════════════════════════════════════════ */
function vmPage(opts) {
  const o = opts || {};
  const title = o.title || "VibeMaestro";
  const body = o.body || "";
  const auto = o.autoRedirect ? `<meta http-equiv="refresh" content="${o.autoRedirect.delay || 1};url=${o.autoRedirect.url}">` : "";
  const extraHead = o.head || "";
  return new Response(
`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${auto}
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect x='2' y='2' width='60' height='60' rx='16' fill='%230e1014'/><path d='M14 46 q6 -8 11 0 t11 0' fill='none' stroke='%238b7bff' stroke-width='3' stroke-linecap='round'/><path d='M35.5 10 L22 34 h8.2 l-3.4 16 L44 25 h-8.2 z' fill='%23f4b640' stroke='%230e1014' stroke-width='1.1' stroke-linejoin='round'/></svg>">
<style>
:root{--bg:#070809;--bg2:#0b0c0f;--panel:#101216;--panel2:#14161c;--ink:#eef1f5;--muted:#9aa1ad;--faint:#5a6072;--line:rgba(255,255,255,.08);--gold:#f4b640;--gold-2:#ffca5a;--gold-line:rgba(244,182,64,.42);--gold-soft:rgba(244,182,64,.14);--dc:#5865F2;--ok:#7ee787;--err:#ff6b6b}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:"WixMadefor",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:radial-gradient(120% 90% at 50% -10%,#12131a 0%,var(--bg) 55%);color:var(--ink);display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.55;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:420px;background:linear-gradient(180deg,rgba(255,255,255,.03),transparent),var(--panel);border:1px solid var(--line);border-radius:20px;padding:40px 34px;box-shadow:0 24px 90px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.04);text-align:center;position:relative;overflow:hidden;animation:rise .45s cubic-bezier(.2,.8,.2,1)}
.card::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--gold),transparent);opacity:.7}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.logo{width:62px;height:62px;border-radius:18px;background:var(--gold-soft);border:1px solid var(--gold-line);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;position:relative}
.logo span{font-size:30px;line-height:1;filter:drop-shadow(0 2px 8px rgba(244,182,64,.5))}
.logo::after{content:"";position:absolute;inset:-8px;border-radius:24px;background:radial-gradient(circle,var(--gold-line),transparent 70%);opacity:.45;z-index:-1;animation:pulse 3.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.3;transform:scale(1)}50%{opacity:.6;transform:scale(1.08)}}
.brand{font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--gold);margin-bottom:6px}
h1{font-size:23px;font-weight:650;letter-spacing:-.4px;margin-bottom:10px}
h1.sm{font-size:20px}
p{color:var(--muted);font-size:14px;max-width:320px;margin:0 auto}
p.tiny{font-size:12px;color:var(--faint);margin-top:18px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:11px;width:100%;margin-top:26px;padding:14px 20px;border:0;border-radius:12px;font-size:15px;font-weight:650;font-family:inherit;cursor:pointer;text-decoration:none;transition:transform .12s,box-shadow .18s,filter .18s}
.btn-dc{background:var(--dc);color:#fff;box-shadow:0 8px 26px rgba(88,101,242,.4)}
.btn-dc:hover{transform:translateY(-1px);box-shadow:0 12px 34px rgba(88,101,242,.55);filter:brightness(1.08)}
.btn-dc:active{transform:translateY(0)}
.btn-ghost{background:var(--panel2);color:var(--ink);border:1px solid var(--line);box-shadow:none;margin-top:12px}
.btn-ghost:hover{border-color:var(--gold-line);color:var(--gold-2)}
.btn svg{width:20px;height:20px;flex:0 0 auto}
.feat{display:flex;flex-direction:column;gap:12px;margin:24px 0 4px;text-align:left}
.feat .row{display:flex;align-items:center;gap:11px;font-size:13.5px;color:var(--muted)}
.feat .row svg{width:17px;height:17px;color:var(--gold);flex:0 0 auto}
.feat .row b{color:var(--ink);font-weight:600}
.spin{width:44px;height:44px;margin:6px auto 20px;border:3px solid var(--line);border-top-color:var(--gold);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.3px;margin-bottom:18px}
.badge.err{background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.35);color:var(--err)}
.badge.warn{background:var(--gold-soft);border:1px solid var(--gold-line);color:var(--gold-2)}
.badge.ok{background:rgba(126,231,135,.12);border:1px solid rgba(126,231,135,.35);color:var(--ok)}
.ico-big{width:58px;height:58px;border-radius:16px;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:30px}
.ico-big.err{background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.3)}
.ico-big.warn{background:var(--gold-soft);border:1px solid var(--gold-line)}
a.link{color:var(--gold-2);text-decoration:none;font-weight:600}
a.link:hover{text-decoration:underline}
.foot{margin-top:26px;font-size:11px;color:var(--faint)}
.foot a{color:var(--faint);text-decoration:none}.foot a:hover{color:var(--muted)}

.logo.mk{background:var(--gold-soft);border:1px solid var(--gold-line)}
.logo.mk svg{filter:drop-shadow(0 2px 8px rgba(244,182,64,.4))}
.ico-big svg{width:30px;height:30px}
.ico-big.err{color:var(--err)}.ico-big.warn{color:var(--gold-2)}
.badge svg{width:13px;height:13px;flex:0 0 auto}
.btn svg{width:18px;height:18px}
.btn-dc svg:first-child{width:20px;height:20px}
</style>${extraHead}</head><body><div class="card">${body}</div></body></html>`,
    { status: o.status || 200, headers: { "content-type": "text/html; charset=utf-8", ...(o.extraHeaders || {}) } }
  );
}

const DC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.8a.07.07 0 0 0-.08.04c-.21.38-.44.87-.61 1.26a18.3 18.3 0 0 0-5.42 0 12.4 12.4 0 0 0-.62-1.26.08.08 0 0 0-.08-.04A19.7 19.7 0 0 0 3.68 4.37a.07.07 0 0 0-.03.03C.53 9.05-.32 13.6.1 18.1a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-2a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1 0-.13l.37-.29a.07.07 0 0 1 .08-.01 14.2 14.2 0 0 0 12.06 0 .07.07 0 0 1 .08 0l.37.3a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.87.89a.08.08 0 0 0-.04.11c.36.7.78 1.36 1.23 1.99a.08.08 0 0 0 .08.04 19.8 19.8 0 0 0 6.02-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.7-3.55-13.7a.06.06 0 0 0-.03-.03ZM8.02 15.35c-1.18 0-2.16-1.08-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.09 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42s.96-2.42 2.15-2.42c1.21 0 2.18 1.09 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

// VM_GATE_NOEMOJI_V1 — real vector marks, never emoji (site rule)
const MARK = '<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true"><defs><linearGradient id="mkG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd372"/><stop offset="1" stop-color="#f4b640"/></linearGradient><linearGradient id="mkV" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#b39dff"/></linearGradient></defs><g fill="none" stroke-linecap="round"><path d="M14 46 q6 -8 11 0 t11 0" stroke="url(#mkV)" stroke-width="3" opacity=".9"/><path d="M16 52 q5.5 -6 11 0 t11 0" stroke="url(#mkV)" stroke-width="2.2" opacity=".4"/></g><path d="M35.5 10 L22 34 h8.2 l-3.4 16 L44 25 h-8.2 z" fill="url(#mkG)" stroke="#0e1014" stroke-width="1.1" stroke-linejoin="round"/></svg>';
const IC_WARN = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const IC_CLOCK = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
const IC_LOCK = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const IC_BAN = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6 18.4 18.4"/></svg>';
const IC_DOOR = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6z"/><path d="M13 12h.01"/><path d="M6 3 3 4v16l3 1"/></svg>';
const IC_RETRY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const IC_SPARK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2l1.9 5.6L19.5 9l-4.6 3.3L16.3 18 12 14.7 7.7 18l1.4-5.7L4.5 9l5.6-1.4z"/></svg>';

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
    const obs = makeObs(env, ctx, "vibemaestro-gate");
    return obs.wrap(async () => {
    const url = new URL(request.url);
    if (url.pathname === "/_diag") {
      let cnt = null; try { cnt = await env.DB.prepare("SELECT COUNT(*) c, MAX(ts) last FROM error_log WHERE worker=? AND ts > ?").bind("vibemaestro-gate", Date.now()-86400000).first(); } catch (e) {}
      return new Response(JSON.stringify({ ok:true, worker:"vibemaestro-gate", ts:Date.now(), errors_24h:cnt }), { headers:{"content-type":"application/json"} });
    }
    const path = url.pathname;

    // ── /login → redirect to Discord authorize ──────────────────
    // debug: report the guild list Discord shows for a fresh OAuth (no login side effects)
    if (path === "/whoami") {
      const code = url.searchParams.get("code");
      if (!code) return json({ error: "append ?code=<oauth code> — or just report this endpoint exists" }, 400);
      const tokRes = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: env.REDIRECT_URI }),
      });
      if (!tokRes.ok) return json({ error: "token", detail: await tokRes.text() }, 401);
      const tok = await tokRes.json();
      const gRes = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": UA } });
      const gl = gRes.ok ? await gRes.json() : [];
      let allowed = []; try { allowed = JSON.parse(await cfg(env, "allowed_guild_ids", "[]")); } catch(_){}
      return json({ your_guild_ids: (Array.isArray(gl)?gl.map(g=>String(g.id)):gl), allowed_guild_ids: allowed });
    }

    if (path === "/login" || path === "/") {
      // VM_GATE_UIUX_V1 — ?go=1 kicks off the real Discord redirect; otherwise show the branded landing.
      if (url.searchParams.get("go") === "1") {
        const state = randSid();
        await env.SESSIONS.put(`state:${state}`, "1", { expirationTtl: 600 });
        const auth = new URL("https://discord.com/oauth2/authorize");
        auth.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
        auth.searchParams.set("redirect_uri", env.REDIRECT_URI);
        auth.searchParams.set("response_type", "code");
        auth.searchParams.set("scope", SCOPES);
        auth.searchParams.set("state", state);
        auth.searchParams.set("prompt", "consent");
        // interstitial so the jump to Discord feels intentional, not a cold bounce
        return vmPage({
          title: "Connecting to Discord — VibeMaestro",
          head: `<meta http-equiv="refresh" content="0.9;url=${auth.toString()}">`,
          body: `<div class="logo mk">${MARK}</div>
            <div class="spin"></div>
            <h1 class="sm">Connecting to Discord\u2026</h1>
            <p>Taking you to Discord to authorize VibeMaestro. This only takes a second.</p>
            <p class="tiny">Not redirected? <a class="link" href="${auth.toString()}">Continue manually</a></p>`
        });
      }
      const already = (request.headers.get("cookie") || "").match(/vm_sid=([a-f0-9]+)/);
      const backHint = already ? `<a class="btn btn-ghost" href="${env.APP_URL || "https://app.example.com"}">Continue to studio \u2192</a>` : "";
      return vmPage({
        title: "Sign in — VibeMaestro",
        body: `<div class="brand">VibeMaestro</div>
          <div class="logo mk">${MARK}</div>
          <h1>Build at the speed of thought</h1>
          <p>Sign in with Discord to spin up apps, agents, and automations \u2014 no card, no forms.</p>
          <div class="feat">
            <div class="row">${CHECK}<span><b>One click</b> \u2014 your Discord account is your key</span></div>
            <div class="row">${CHECK}<span><b>Members-only</b> \u2014 access is tied to your server standing</span></div>
            <div class="row">${CHECK}<span><b>Private</b> \u2014 we only read your identity & servers</span></div>
          </div>
          <a class="btn btn-dc" href="/login?go=1">${DC_ICON}<span>Continue with Discord</span></a>
          ${backHint}
          <div class="foot"><a href="https://vibemaestro.app/about">About</a> \u00b7 <a href="https://vibemaestro.app">vibemaestro.app</a></div>`
      });
    }

    // ── /callback → exchange code, verify standing, issue session ─
    if (path === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) return json({ error: "missing code/state" }, 400);
      const okState = await env.SESSIONS.get(`state:${state}`);
      if (!okState) return vmPage({ title: "Session expired — VibeMaestro", status: 400, body: `<div class="ico-big warn">${IC_CLOCK}</div><span class="badge warn">Link expired</span><h1 class="sm">That sign-in link timed out</h1><p>For your security, login links are only valid for a few minutes. Let\u2019s start fresh.</p><a class="btn btn-dc" href="/login?go=1">${IC_RETRY} <span>Try signing in again</span></a>` });
      await env.SESSIONS.delete(`state:${state}`);

      // 1) token exchange
      const tokRes = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: env.REDIRECT_URI,
        }),
      });
      if (!tokRes.ok) return vmPage({ title: "Sign-in failed — VibeMaestro", status: 401, body: `<div class="ico-big err">${IC_WARN}</div><span class="badge err">Discord handshake failed</span><h1 class="sm">We couldn\u2019t complete sign-in</h1><p>Discord didn\u2019t confirm your login. This is usually temporary \u2014 please try again.</p><a class="btn btn-dc" href="/login?go=1">${IC_RETRY} <span>Retry with Discord</span></a>` });
      const tok = await tokRes.json();

      // 2) who is this user
      const meRes = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": UA },
      });
      const me = await meRes.json();

      // 3) membership + roles — pass if member of ANY allowed guild (bot-token read = authoritative)
      //    allowed_guild_ids: JSON array. Falls back to legacy active_guild_id if unset.
      let allowedGuilds = [];
      try {
        allowedGuilds = JSON.parse(await cfg(env, "allowed_guild_ids", "[]"));
      } catch (_) {}
      if (!Array.isArray(allowedGuilds) || allowedGuilds.length === 0) {
        allowedGuilds = [await cfg(env, "active_guild_id", "")];
      }

      // 3b) AUTO-PROMOTE: any pending guild the bot can now READ (i.e. it got invited) becomes active.
      //     Bot can't self-join (Discord requires a human invite), but the moment it lands in a
      //     pending server this flips it live with zero manual steps.
      try {
        const pending = JSON.parse(await cfg(env, "pending_guild_ids", "[]"));
        if (Array.isArray(pending) && pending.length) {
          const stillPending = [];
          let promoted = false;
          for (const gid of pending) {
            const probe = await fetch(`https://discord.com/api/v10/guilds/${gid}`, {
              headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "user-agent": UA },
            });
            if (probe.ok) {
              if (!allowedGuilds.includes(gid)) { allowedGuilds.push(gid); promoted = true; }
            } else {
              stillPending.push(gid); // bot not in it yet — keep waiting
            }
          }
          if (promoted) {
            await env.DB.prepare(
              "INSERT INTO config (key,value) VALUES ('allowed_guild_ids',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
            ).bind(JSON.stringify(allowedGuilds)).run();
            await env.DB.prepare(
              "INSERT INTO config (key,value) VALUES ('pending_guild_ids',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
            ).bind(JSON.stringify(stillPending)).run();
          }
        }
      } catch (_) { /* auto-promote is best-effort; never blocks login */ }

      const badRolesRaw = await cfg(env, "bad_standing_roles", "[]");
      let badRoles = [];
      try { badRoles = JSON.parse(badRolesRaw); } catch (_) {}

      let standing = "unknown";
      let isMember = false;
      let roles = [];
      let matchedGuild = null;

      // 3c) PRIMARY membership check = the USER'S OWN guild list (OAuth `guilds` scope).
      //     This is authoritative regardless of whether the bot is in the guild, which is the
      //     correct source of truth for "is this human in one of our servers".
      let userGuildIds = [];
      try {
        const gRes = await fetch("https://discord.com/api/v10/users/@me/guilds", {
          headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": UA },
        });
        if (gRes.ok) {
          const gl = await gRes.json();
          if (Array.isArray(gl)) userGuildIds = gl.map((g) => String(g.id));
        }
      } catch (_) { /* fall through to bot check */ }

      for (const gid of allowedGuilds) {
        if (userGuildIds.includes(String(gid))) {
          isMember = true;
          matchedGuild = String(gid);
          standing = "good"; // default good; refined below if bot can read roles
          break;
        }
      }

      // 3d) SECONDARY (best-effort): if the bot IS in the matched guild, read roles for standing.
      //     Also serves as a fallback membership signal if the user's guild list was unavailable.
      for (const gid of allowedGuilds) {
        if (isMember && String(gid) !== matchedGuild) continue;
        const memRes = await fetch(
          `https://discord.com/api/v10/guilds/${gid}/members/${me.id}`,
          { headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "user-agent": UA } }
        );
        if (!memRes.ok) continue;               // bot not in this guild / user not in it
        const mem = await memRes.json();
        isMember = true;
        matchedGuild = String(gid);
        roles = mem.roles || [];
        const timedOut =
          mem.communication_disabled_until &&
          new Date(mem.communication_disabled_until) > new Date();
        standing = (timedOut || roles.some((r) => badRoles.includes(r))) ? "bad" : "good";
        if (standing === "good") break;
      }

      if (!isMember) {
        // VM_GATE_UIUX_V1 — friendly branded "join first" page instead of a silent bounce.
        return vmPage({ title: "Join to get in — VibeMaestro", status: 403, body: `<div class="brand">VibeMaestro</div><div class="ico-big warn">${IC_DOOR}</div><span class="badge warn">Members only</span><h1 class="sm">You\u2019re almost in</h1><p>VibeMaestro access is granted through our Discord community. Join the server, then come back and sign in \u2014 you\u2019ll be let right through.</p><a class="btn btn-dc" href="https://discord.gg/your-invite">${DC_ICON}<span>Join the Discord</span></a><a class="btn btn-ghost" href="/login?go=1">I\u2019ve joined \u2014 try again</a><div class="foot"><a href="https://vibemaestro.app/about">Learn more about VibeMaestro</a></div>` });
      }
      if (standing === "bad") {
        return vmPage({ title: "Access paused — VibeMaestro", status: 403, body: `<div class="ico-big warn">${IC_LOCK}</div><span class="badge warn">Access paused</span><h1 class="sm">Your access is on hold</h1><p>Your current standing in the Discord community doesn\u2019t allow access right now. If you think this is a mistake, reach out to a moderator in the server.</p><a class="btn btn-ghost" href="https://vibemaestro.app">Back to home</a>` });
      }

      // 4) upsert user
      await env.DB.prepare(
        `INSERT INTO users (discord_id, username, global_name, avatar, standing, last_login)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(discord_id) DO UPDATE SET
           username=excluded.username, global_name=excluded.global_name,
           avatar=excluded.avatar, standing=excluded.standing, last_login=datetime('now')`
      ).bind(me.id, me.username || "", me.global_name || "", me.avatar || "", standing).run();

      // check suspended
      const urow = await env.DB.prepare("SELECT suspended, tier, access_level FROM users WHERE discord_id=?").bind(me.id).first();
      if (urow && urow.suspended) return vmPage({ title: "Account suspended — VibeMaestro", status: 403, body: `<div class="ico-big err">${IC_BAN}</div><span class="badge err">Suspended</span><h1 class="sm">This account is suspended</h1><p>Your VibeMaestro account has been suspended. If you believe this is an error, contact support in the Discord.</p><a class="btn btn-ghost" href="https://vibemaestro.app">Back to home</a>` });

      // v3 GATE: resolve access_level. Pete is always approved. If the gate kill-switch is off
      // (config.gate_enabled='0') everyone who is a member passes as 'approved' (legacy behavior).
      const OWNER_ID = env.OWNER_DISCORD_ID || ""; // your Discord user id — always approved
      const gateEnabled = (await cfg(env, "gate_enabled", "1")) !== "0";
      let access_level = (urow && urow.access_level) || "pending";
      if (OWNER_ID && me.id === OWNER_ID) access_level = "approved";
      else if (!gateEnabled) access_level = "approved";

      // 5) issue session (KV + D1)
      const sid = randSid();
      const expires = new Date(Date.now() + 7 * 864e5).toISOString();
      const sess = { sid, discord_id: me.id, tier: (urow && urow.tier) || "free", standing, access_level };
      await env.SESSIONS.put(`sess:${sid}`, JSON.stringify(sess), { expirationTtl: 7 * 86400 });
      await env.DB.prepare(
        `INSERT INTO sessions (sid, discord_id, expires_at, ua) VALUES (?, ?, ?, ?)`
      ).bind(sid, me.id, expires, request.headers.get("user-agent") || "").run();

      // 6) VM_GATE_UIUX_V1 — set the session cookie, then a branded welcome handoff (feels like an arrival, not a bounce).
      const appUrl = env.APP_URL || "https://app.example.com";
      const who = (me.global_name || me.username || "").trim();
      const hi = who ? `Welcome, ${who.replace(/[<>&]/g, "")}` : "Welcome back";
      const av = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : "";
      const avHtml = av
        ? `<div class="logo" style="overflow:hidden;padding:0"><img src="${av}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:17px"></div>`
        : `<div class="logo mk">${MARK}</div>`;
      const tierBadge = ((urow && urow.tier) || "free") === "paid"
        ? `<span class="badge ok">${IC_SPARK} Paid \u00b7 all systems go</span>`
        : `<span class="badge ok" style="background:var(--gold-soft);border-color:var(--gold-line);color:var(--gold-2)">${IC_SPARK} Signed in</span>`;
      const page = vmPage({
        title: "Welcome — VibeMaestro",
        head: `<meta http-equiv="refresh" content="1.4;url=${appUrl}">`,
        extraHeaders: { "Set-Cookie": `vm_sid=${sid}; Domain=.vibemaestro.app; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 86400}` },
        body: `<div class="brand">VibeMaestro</div>${avHtml}${tierBadge}<h1 class="sm">${hi}</h1><p>You\u2019re signed in. Taking you to your studio\u2026</p><div class="spin" style="margin-top:22px"></div><p class="tiny">Not moving? <a class="link" href="${appUrl}">Enter the studio \u2192</a></p>`
      });
      return page;
    }

    // ── /service/mint-session → SERVICE-ONLY: mint a session for a known Discord user ──
    // Bridge-secret guarded. Used by the VibeMaestro Discord bot's /build command so a
    // member can build+ship entirely inside Discord without a browser login. Only mints
    // for users whose access_level is 'approved' (Pete always approved). Honors suspended.
    if (path === "/service/mint-session" && request.method === "POST") {
      const secret = request.headers.get("x-bot-service-key") || "";
      if (!env.BOT_SERVICE_KEY || secret !== env.BOT_SERVICE_KEY) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
      const b = await request.json().catch(() => ({}));
      const did = String(b.discord_id || "").replace(/[^0-9]/g, "");
      if (!did) return json({ ok: false, error: "discord_id required" }, 400);

      const OWNER_ID = env.OWNER_DISCORD_ID || ""; // your Discord user id — always approved
      const urow = await env.DB.prepare(
        "SELECT suspended, tier, access_level FROM users WHERE discord_id=?"
      ).bind(did).first();
      if (urow && urow.suspended) return json({ ok: false, error: "suspended" }, 403);

      const gateEnabled = (await cfg(env, "gate_enabled", "1")) !== "0";
      let access_level = (urow && urow.access_level) || "pending";
      if (OWNER_ID && did === OWNER_ID) access_level = "approved";
      else if (!gateEnabled) access_level = "approved";
      if (access_level !== "approved") {
        return json({ ok: false, error: "not_approved", access_level }, 403);
      }

      const sid = randSid();
      const expires = new Date(Date.now() + 24 * 3600e3).toISOString(); // 24h — short-lived service session
      const sess = { sid, discord_id: did, tier: (urow && urow.tier) || "free", standing: "good", access_level, via: "bot" };
      await env.SESSIONS.put(`sess:${sid}`, JSON.stringify(sess), { expirationTtl: 24 * 3600 });
      await env.DB.prepare(
        "INSERT INTO sessions (sid, discord_id, expires_at, ua) VALUES (?, ?, ?, ?)"
      ).bind(sid, did, expires, "vm-bot/build").run();
      return json({ ok: true, sid, access_level });
    }

    // ── /verify → other workers call this to validate a session ──
    if (path === "/verify") {
      const sid =
        (request.headers.get("cookie") || "").match(/vm_sid=([a-f0-9]+)/)?.[1] ||
        url.searchParams.get("sid");
      if (!sid) return json({ ok: false, error: "no session" }, 401);
      const raw = await env.SESSIONS.get(`sess:${sid}`);
      if (!raw) return json({ ok: false, error: "expired" }, 401);
      return json({ ok: true, session: JSON.parse(raw) });
    }

    // ── /logout ──────────────────────────────────────────────────
    if (path === "/logout") {
      const sid = (request.headers.get("cookie") || "").match(/vm_sid=([a-f0-9]+)/)?.[1];
      if (sid) await env.SESSIONS.delete(`sess:${sid}`);
      const headers = new Headers();
      headers.set("Location", "https://vibemaestro.app");
      headers.append("Set-Cookie", `vm_sid=; Domain=.vibemaestro.app; Path=/; Max-Age=0`);
      return new Response(null, { status: 302, headers });
    }

    return json({ error: "not found" }, 404);
    }, request);
  },
};

