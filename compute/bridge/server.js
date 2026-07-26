/**
 * VibeMaestro Compute Bridge
 * ───────────────────────────────────────────────────────────────────────────
 * The ONLY public door to the OpenCode compute plane. OpenCode's own server has no
 * built-in auth, so it stays private + password-gated on loopback; this bridge:
 *   1. Accepts requests from the public edge (app.example.com proxies here).
 *   2. Requires a valid vm_sid session (verified against gate.example.com/verify).
 *   3. Injects the OPENCODE_SERVER_PASSWORD and proxies to OpenCode on 127.0.0.1:4096.
 *   4. Namespaces each user to their own OpenCode session id (KV-free: derived from discord_id).
 *
 * Env: OPENCODE_SERVER_PASSWORD, GATE_URL (https://gate.example.com),
 *      OPENCODE_URL (http://127.0.0.1:4096), BRIDGE_SHARED_SECRET (app-worker <-> bridge)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const DATA = process.env.DATA_URL || "https://data.example.com";
const PUBLISH = process.env.PUBLISH_URL || "https://publish.example.com";
const WORKSPACES = process.env.WORKSPACES_DIR || "/workspaces";

const OC = process.env.OPENCODE_URL || "http://127.0.0.1:4096";
const OC_PW = process.env.OPENCODE_SERVER_PASSWORD || "";
const GATE = process.env.GATE_URL || "https://gate.example.com";
const SHARED = process.env.BRIDGE_SHARED_SECRET || "";
const UA = "Mozilla/5.0 (VibeMaestro/1.0)";
const PORT = Number(process.env.PORT || 8080);

function j(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// Verify the caller: must present the app<->bridge shared secret AND a valid vm_sid.
async function authorize(req) {
  if (SHARED && req.headers["x-bridge-secret"] !== SHARED) return { ok: false, code: 403, err: "bad bridge secret" };
  const sid = (req.headers["x-vm-sid"] || "").toString().match(/^[a-f0-9]{8,}$/)?.[0];
  if (!sid) return { ok: false, code: 401, err: "no session" };
  try {
    const r = await fetch(`${GATE}/verify?sid=${sid}`, { headers: { "user-agent": UA } });
    if (!r.ok) return { ok: false, code: 401, err: "session invalid" };
    const d = await r.json();
    if (!d.ok) return { ok: false, code: 401, err: "session expired" };
    return { ok: true, session: d.session };
  } catch (e) {
    return { ok: false, code: 502, err: "gate unreachable" };
  }
}

// Call OpenCode with the server password attached.
async function oc(path, method, body) {
  const headers = { "content-type": "application/json", "user-agent": UA };
  if (OC_PW) headers["authorization"] = "Basic " + Buffer.from(`opencode:${OC_PW}`).toString("base64");
  const r = await fetch(`${OC}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

// Call the data worker (owns R2+D1; the box holds no CF creds).
async function data(path, method, body) {
  const headers = { "content-type": "application/json", "user-agent": UA, "x-bridge-secret": SHARED };
  const r = await fetch(`${DATA}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const t = await r.text(); let parsed; try { parsed = JSON.parse(t); } catch { parsed = { raw: t }; }
  return { status: r.status, body: parsed };
}

async function pub(path, method, body) {
  const headers = { "content-type": "application/json", "user-agent": UA, "x-bridge-secret": SHARED };
  const r = await fetch(`${PUBLISH}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(40000) });
  const t = await r.text(); let parsed; try { parsed = JSON.parse(t); } catch { parsed = { raw: t }; }
  return { status: r.status, body: parsed };
}

function projDir(uid, pid) { return path.join(WORKSPACES, String(uid), String(pid)); }

// Fallback for small free models that emit code as markdown instead of tool calls.
// Extract fenced blocks with a filename hint and write them into the project dir.
// Recognizes: ```lang title="index.html" , ```html:index.html , or a "**index.html**" / "`index.html`" line just above a fence.
function extractFilesFromMarkdown(md, dir) {
  const written = [];
  const lines = md.split("\n");
  let i = 0;
  const fileHintRe = /(?:^|\s)(?:file[:=]\s*)?[`*"']?([\w./-]+\.(?:html?|css|js|mjs|json|svg|txt|md))[`*"']?/i;
  let pendingName = null;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```([\w-]*)(?:\s+(?:title=|file=)?["']?([\w./-]+)["']?)?/);
    if (fence) {
      let fname = fence[2] || pendingName;
      const lang = (fence[1] || "").toLowerCase();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      if (!fname) {
        if (lang === "html") fname = "index.html";
        else if (lang === "css") fname = "styles.css";
        else if (lang === "js" || lang === "javascript") fname = "app.js";
        else { pendingName = null; continue; }
      }
      fname = fname.replace(/^[./]+/, "");
      const abs = path.join(dir, fname);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf.join("\n"));
        written.push(fname);
      } catch {}
      pendingName = null;
      continue;
    }
    // capture a filename mentioned on its own-ish line as a hint for the next fence
    const hint = line.match(fileHintRe);
    if (hint && line.length < 120) pendingName = hint[1].replace(/^[./]+/, "");
    i++;
  }
  return written;
}

// Hydrate a project's files from R2 into a scratch checkout dir.
async function checkout(uid, pid) {
  const dir = projDir(uid, pid);
  fs.mkdirSync(dir, { recursive: true });
  const h = await data("/project/hydrate", "POST", { project_id: pid });
  const files = h.body?.files || [];
  for (const f of files) {
    const abs = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(f.content_b64, "base64"));
  }
  return { dir, count: files.length };
}

// Post-generation safety net: if index.html uses VMDB()/VM* globals but the SDK
// script tag isn't in <head>, inject it. Belt-and-suspenders against the free model
// omitting the tag or ordering it after the code (the classic "VMDB is not defined").
function fixVmdbOrdering(dir) {
  try {
    const idx = path.join(dir, "index.html");
    if (!fs.existsSync(idx)) return false;
    let html = fs.readFileSync(idx, "utf8");
    const usesVM = /\bVMDB\s*\(|\bVMAuth\b|\bVMUpload\s*\(|\bVMEmail\s*\(|\bVMLLM\s*\(|\bVMMigrate\b|\bVMAutomations\b/.test(html);
    if (!usesVM) return false;
    const hasTag = /<script[^>]+src=["']\/__db\/sdk\.js["']/.test(html);
    if (hasTag) return false;
    const tag = '<script src="/__db/sdk.js"></script>';
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, (m) => m + "\n  " + tag);
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, (m) => m + "\n<head>\n  " + tag + "\n</head>");
    } else {
      html = tag + "\n" + html;
    }
    fs.writeFileSync(idx, html);
    return true;
  } catch { return false; }
}

// Walk the scratch dir and push every file back to R2 via the data worker.
async function syncBack(uid, pid) {
  const dir = projDir(uid, pid);
  const sdkFixed = fixVmdbOrdering(dir);
  const out = [];
  function walk(d, rel) {
    for (const name of fs.readdirSync(d)) {
      if (name === "node_modules" || name === ".git" || name.startsWith(".opencode")) continue;
      const abs = path.join(d, name); const r = rel ? rel + "/" + name : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.size <= 2 * 1024 * 1024) out.push({ path: r, abs });
    }
  }
  try { walk(dir, ""); } catch {}
  let synced = 0;
  for (const f of out) {
    const buf = fs.readFileSync(f.abs);
    const b64 = buf.toString("base64");
    const w = await data("/project/write", "POST", { project_id: pid, path: f.path, content: b64, b64: true });
    if (w.status < 300) synced++;
  }
  return { synced, total: out.length, files: out.map((x) => x.path) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/health") return j(res, 200, { ok: true, service: "bridge" });

  // TEMP diagnostic (secret-gated): probe OpenCode's API surface from inside the machine.
  if (p === "/diag") {
    if (req.headers["x-bridge-secret"] !== SHARED) return j(res, 403, { error: "nope" });
    const tries = {};
    async function probe(path, method, body) {
      try {
        const h = { "content-type": "application/json", "user-agent": UA };
        if (OC_PW) h["authorization"] = "Basic " + Buffer.from(`opencode:${OC_PW}`).toString("base64");
        const r = await fetch(`${OC}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
        const t = await r.text();
        tries[`${method} ${path}`] = { status: r.status, body: t.slice(0, 300) };
      } catch (e) { tries[`${method} ${path}`] = { err: String(e) }; }
    }
    await probe("/global/health", "GET");
    await probe("/session", "GET");
    await probe("/session", "POST", {});
    await probe("/agent", "GET");
    await probe("/config", "GET");
    await probe("/path", "GET");
    return j(res, 200, { oc: OC, hasPw: !!OC_PW, tries });
  }

  const auth = await authorize(req);
  if (!auth.ok) return j(res, auth.code, { error: auth.err });
  const uid = auth.session.discord_id;

  // POST /ask { prompt }  → ensure a per-user OpenCode session, send the prompt, return the reply.
  if (p === "/ask" && req.method === "POST") {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch {}
    const prompt = String(payload.prompt || "").slice(0, 4000);
    if (!prompt) return j(res, 400, { error: "empty prompt" });

    // 1) get-or-create this user's OpenCode session
    let sessionId = payload.session_id;
    if (!sessionId) {
      const created = await oc("/session", "POST", { title: `vm-${uid}` });
      if (created.status >= 300) return j(res, 502, { error: "session create failed", detail: created.body });
      sessionId = created.body.id;
    }

    // 2) send the message to the Capy agent
    const sent = await oc(`/session/${sessionId}/message`, "POST", {
      agent: "capy",
      parts: [{ type: "text", text: prompt }],
    });
    if (sent.status >= 300) return j(res, 502, { error: "message failed", detail: sent.body, session_id: sessionId });

    // 3) extract the assistant text from the response parts
    const parts = sent.body?.parts || sent.body?.message?.parts || [];
    const text = parts.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim() ||
                 sent.body?.text || "(Capy is thinking — try again)";
    return j(res, 200, { text, session_id: sessionId });
  }

  // POST /project/:id/build { prompt }  → Capy edits real files in the project's scratch checkout,
  // then all changes sync back to R2. Returns Capy's message + the updated file manifest.
  // POST /project/:id/build/stream  → SAME as /build but streams progress via SSE.
  // Additive: the blocking /build route below stays as the fallback.
  const mStream = p.match(/^\/project\/([A-Za-z0-9_]+)\/build\/stream$/);
  if (mStream && req.method === "POST") {
    const pid = mStream[1];
    let payload = {}; try { payload = JSON.parse(await readBody(req)); } catch {}
    const prompt = String(payload.prompt || "").slice(0, 6000);
    if (!prompt) return j(res, 400, { error: "empty prompt" });

    // SSE headers
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event, obj) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`); } catch {} };
    const hb = setInterval(() => { try { res.write(":hb\n\n"); } catch {} }, 15000);
    let closed = false;
    const finish = () => { if (closed) return; closed = true; clearInterval(hb); try { res.end(); } catch {} };
    req.on("close", finish);

    try {
      send("status", { phase: "checkout" });
      let dir;
      try { ({ dir } = await checkout(uid, pid)); }
      catch (e) { send("error", { error: "checkout failed: " + String(e) }); return finish(); }

      const created = await oc("/session", "POST", { title: `vm-${uid}-${pid}`, directory: dir });
      if (created.status >= 300) { send("error", { error: "session create failed" }); return finish(); }
      const sessionId = created.body.id;
      send("status", { phase: "thinking" });

      const sysHint = `You are editing a real web-app project located at ${dir}. `
      + `Create/modify files DIRECTLY on disk in that directory using your file tools (write/edit). `
      + `Build a working static web app (index.html is the entry point; plain HTML/CSS/JS or React via CDN \u2014 no build step). `
      + `BUILD THE SPECIFIC APP THE USER ASKED FOR \u2014 read their request literally and build THAT. Do NOT default to a generic todo list, \"items list,\" or notes app unless they explicitly asked for one. `
      + `MAKE IT LOOK GOOD: system font stack, consistent 8/12/16/24px spacing, one restrained accent color on neutral surfaces, rounded corners, responsive, a real (not blank) empty/loading state. `
      + `PERSISTENCE (only if the app genuinely needs to SAVE data across reloads/devices \u2014 posts, bookings, scores, signups; NOT for a calculator, timer, or purely visual page): use the free zero-config same-origin database. `
      + `CRITICAL ORDER RULE to avoid \"VMDB is not defined\": put <script src=\"/__db/sdk.js\"></script> in <head> BEFORE any app JS, and NEVER call VMDB() at top-level \u2014 wrap ALL db calls in a DOMContentLoaded handler. `
      + `API: const db = VMDB(\"posts\"); await db.create({...}); const rows = await db.list(); await db.update(id,{...}); await db.remove(id); \u2014 name the collection for the data (not \"items\"). Each record auto-gets id, created_at, updated_at. `
      + `Do NOT use localStorage for data that should persist server-side. For ephemeral UI state, plain JS is fine. `
      + `SELF-CHECK before finishing: (a) runs with ZERO console errors, (b) if it uses VMDB the SDK is in <head> and db calls are inside DOMContentLoaded, (c) it does what the user actually asked \u2014 not a generic stub. Fix anything that fails. `
      + `After making changes, briefly summarize what you built. User request: `;

      // Open OpenCode's global SSE event stream BEFORE sending the message.
      const evHeaders = { "user-agent": UA };
      if (OC_PW) evHeaders["authorization"] = "Basic " + Buffer.from(`opencode:${OC_PW}`).toString("base64");
      const evCtl = new AbortController();
      let evResp;
      try {
        evResp = await fetch(`${OC}/event`, { headers: evHeaders, signal: evCtl.signal });
      } catch (e) { evResp = null; }

      // Fire the build message WITHOUT awaiting full completion (progress comes via /event).
      const msgPromise = oc(`/session/${sessionId}/message`, "POST", {
        agent: "capy",
        parts: [{ type: "text", text: sysHint + prompt }],
      });

      const seenFiles = new Set();
      let sawWriting = false;
      const doneTurn = async () => {
        try { evCtl.abort(); } catch {}
        send("status", { phase: "syncing" });
        // ensure the message POST resolved so disk is settled
        let msgText = "";
        try {
          const sent = await msgPromise;
          const parts = sent.body?.parts || [];
          msgText = parts.filter((x) => x.type === "text" && !String(x.text||"").startsWith("You are editing a real web-app project")).map((x) => x.text).join("\n").trim();
        } catch {}
        let extracted = [];
        try { extracted = extractFilesFromMarkdown(msgText, dir); } catch {}
        const sync = await syncBack(uid, pid);
        send("done", { text: msgText || "(Capy worked on your project.)", files: sync.files, synced: sync.synced, extracted });
        finish();
      };

      if (evResp && evResp.body) {
        // Node fetch body is a web ReadableStream; read + parse SSE frames.
        const reader = evResp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const idleTimeout = setTimeout(() => { doneTurn(); }, 180000); // hard cap 3m
        (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let idx;
              while ((idx = buf.indexOf("\n\n")) >= 0) {
                const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
                const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
                if (!dataLine) continue;
                let ev; try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
                const props = ev.properties || {};
                // scope to our session where possible
                const sid = props.sessionID || props.sessionId || props.part?.sessionID || props.info?.sessionID;
                if (sid && sid !== sessionId) continue;
                if (ev.type === "message.part.updated") {
                  const part = props.part || {};
                  if (part.type === "text" && part.text) {
                    if (part.text.startsWith("You are editing a real web-app project")) continue;
                    if (!sawWriting) { sawWriting = true; send("status", { phase: "writing" }); }
                    send("delta", { text: part.text });
                  } else if (part.type === "tool" && (part.tool || part.name)) {
                    const tn = part.tool || part.name;
                    const fp = part.state?.input?.filePath || part.state?.input?.path || part.input?.filePath;
                    if (fp && !seenFiles.has(fp)) { seenFiles.add(fp); send("file", { name: fp.split("/").pop(), op: tn }); }
                  }
                } else if (ev.type === "session.idle" && (!sid || sid === sessionId)) {
                  clearTimeout(idleTimeout); return doneTurn();
                }
              }
            }
          } catch (e) { /* stream aborted on doneTurn */ }
        })();
      } else {
        // No event stream available — degrade: await the message, then done.
        send("status", { phase: "writing" });
        await msgPromise.catch(() => {});
        return doneTurn();
      }
    } catch (e) {
      send("error", { error: String(e) });
      finish();
    }
    return;
  }

  const mBuild = p.match(/^\/project\/([A-Za-z0-9_]+)\/build$/);
  if (mBuild && req.method === "POST") {
    const pid = mBuild[1];
    let payload = {}; try { payload = JSON.parse(await readBody(req)); } catch {}
    const prompt = String(payload.prompt || "").slice(0, 6000);
    if (!prompt) return j(res, 400, { error: "empty prompt" });

    // 1) hydrate the project into a scratch dir the agent can edit
    let dir;
    try { ({ dir } = await checkout(uid, pid)); }
    catch (e) { return j(res, 502, { error: "checkout failed", detail: String(e) }); }

    // 2) run Capy in a session rooted at the project dir (directory param scopes the worktree)
    const created = await oc("/session", "POST", { title: `vm-${uid}-${pid}`, directory: dir });
    if (created.status >= 300) return j(res, 502, { error: "session create failed", detail: created.body });
    const sessionId = created.body.id;

    const sysHint = `You are editing a real web-app project located at ${dir}. `
      + `Create/modify files DIRECTLY on disk in that directory using your file tools (write/edit). `
      + `Build a working static web app (index.html is the entry point; plain HTML/CSS/JS or React via CDN \u2014 no build step). `
      + `BUILD THE SPECIFIC APP THE USER ASKED FOR \u2014 read their request literally and build THAT. Do NOT default to a generic todo list, \"items list,\" or notes app unless they explicitly asked for one. `
      + `MAKE IT LOOK GOOD: system font stack, consistent 8/12/16/24px spacing, one restrained accent color on neutral surfaces, rounded corners, responsive, a real (not blank) empty/loading state. `
      + `PERSISTENCE (only if the app genuinely needs to SAVE data across reloads/devices \u2014 posts, bookings, scores, signups; NOT for a calculator, timer, or purely visual page): use the free zero-config same-origin database. `
      + `CRITICAL ORDER RULE to avoid \"VMDB is not defined\": put <script src=\"/__db/sdk.js\"></script> in <head> BEFORE any app JS, and NEVER call VMDB() at top-level \u2014 wrap ALL db calls in a DOMContentLoaded handler. `
      + `API: const db = VMDB(\"posts\"); await db.create({...}); const rows = await db.list(); await db.update(id,{...}); await db.remove(id); \u2014 name the collection for the data (not \"items\"). Each record auto-gets id, created_at, updated_at. `
      + `Do NOT use localStorage for data that should persist server-side. For ephemeral UI state, plain JS is fine. `
      + `SELF-CHECK before finishing: (a) runs with ZERO console errors, (b) if it uses VMDB the SDK is in <head> and db calls are inside DOMContentLoaded, (c) it does what the user actually asked \u2014 not a generic stub. Fix anything that fails. `
      + `After making changes, briefly summarize what you built. User request: `;

    const sent = await oc(`/session/${sessionId}/message`, "POST", {
      agent: "capy",
      parts: [{ type: "text", text: sysHint + prompt }],
    });
    if (sent.status >= 300) return j(res, 502, { error: "build message failed", detail: sent.body });

    const parts = sent.body?.parts || [];
    const text = parts.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim() ||
                 "(Capy worked on your project.)";

    // 3) fallback: if the free model wrote code as markdown instead of using file tools,
    // extract fenced code blocks and write them to disk so the project actually updates.
    let extracted = [];
    try { extracted = extractFilesFromMarkdown(text, dir); } catch {}

    // 4) sync the edited files back to R2 (source of truth)
    const sync = await syncBack(uid, pid);

    return j(res, 200, { text, session_id: sessionId, files: sync.files, synced: sync.synced, extracted });
  }

  // GET /publish/check?sub=<name>  → subdomain availability (proxied to publish worker)
  if (p === "/publish/check") {
    const sub = (url.searchParams.get("sub") || "").toLowerCase();
    const r = await pub(`/check?sub=${encodeURIComponent(sub)}`, "GET");
    return j(res, r.status, r.body);
  }

  // POST /project/:id/publish { subdomain }  → publish the project to <sub>.your-domain.com
  const mPub = p.match(/^\/project\/([A-Za-z0-9_]+)\/publish$/);
  if (mPub && req.method === "POST") {
    const pid = mPub[1];
    let payload = {}; try { payload = JSON.parse(await readBody(req)); } catch {}
    const subdomain = String(payload.subdomain || "").toLowerCase();
    const r = await pub("/publish", "POST", { user_discord_id: uid, project_id: pid, subdomain });
    return j(res, r.status, r.body);
  }

  // POST /project/:id/unpublish { subdomain }
  const mUnpub = p.match(/^\/project\/([A-Za-z0-9_]+)\/unpublish$/);
  if (mUnpub && req.method === "POST") {
    let payload = {}; try { payload = JSON.parse(await readBody(req)); } catch {}
    const r = await pub("/unpublish", "POST", { user_discord_id: uid, subdomain: String(payload.subdomain || "").toLowerCase() });
    return j(res, r.status, r.body);
  }

  // GET /my/apps  → list this user's live published apps
  if (p === "/my/apps") {
    const r = await pub(`/list?user=${encodeURIComponent(uid)}`, "GET");
    return j(res, r.status, r.body);
  }

  // GET /my/projects  → list this user's projects
  if (p === "/my/projects") {
    const r = await data(`/project/list?user=${encodeURIComponent(uid)}`, "GET");
    return j(res, r.status, r.body);
  }

  // POST /project/create { name }
  if (p === "/project/create" && req.method === "POST") {
    let payload = {}; try { payload = JSON.parse(await readBody(req)); } catch {}
    const r = await data("/project/create", "POST", { user_discord_id: uid, name: String(payload.name || "Untitled") });
    return j(res, r.status, r.body);
  }

  // POST /project/:id/rename { name }
  {
    const rm = p.match(/^\/project\/([A-Za-z0-9_]+)\/rename$/);
    if (rm && req.method === "POST") {
      let payload = {}; try { payload = JSON.parse(await readBody(req)); } catch {}
      const r = await data("/project/rename", "POST", { user_discord_id: uid, project_id: rm[1], name: String(payload.name || "").slice(0, 60) });
      return j(res, r.status, r.body);
    }
  }

  return j(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`bridge listening on :${PORT} -> ${OC}`));
