// web.mjs — a read-only local web view of one agent: identity, profile, friends,
// pending friend requests and each friend's chat.
//
//   mesh web [--port 8770]          serve it (foreground) for $DECENT_PEER_HOME
//   mesh start --web [--port 8770]  the daemon serves it as well
//
// Avatars: a friend's avatarUrl (https) or its CryptoPunks id via www.larvalabs.com. The page
// loads those images straight from their hosts (no referrer), as the Beagle apps do.
//
// The page is the Beagle chat UI itself (@decentnetwork/beagle-ui, the same components as the
// desktop app on :8766 and beagle-web): mesh web answers the two routes it reads, /api/desktop
// (me, friends, requests) and /api/chat-history (one conversation), from the agent's files.
// Every write route answers "read-only". The plain fallback page is at /simple.
//
// Safety:
//   - binds 127.0.0.1 only; requests whose Host header is not 127.0.0.1/localhost are refused
//     (stops DNS-rebinding pages from reading it); no CORS headers; GET/HEAD only.
//   - it reads an allow-list of files and copies an allow-list of fields out of them. It never
//     opens peer.save (the private key) or config.json, and serves no files from disk.
//   - read-only: it never writes to outbox.jsonl or anything else.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { punkImageUrl } from "./profile.mjs";

export const DEFAULT_WEB_PORT = 8770;

let toUserid = (s) => s;
try {
  const { carrierIdFromAddress } = await import("@decentnetwork/peer");
  toUserid = (s) => { try { return carrierIdFromAddress(s); } catch { return s; } };
} catch { /* the SDK is a dependency; without it addresses are matched as-is */ }

const pick = (o, keys) => { const r = {}; for (const k of keys) if (o?.[k] !== undefined) r[k] = o[k]; return r; };

/** Everything the page shows, built from the agent's files. Pure function of `home`. */
export function buildState(home, { maxPerChat = 500 } = {}) {
  const P = (f) => join(home, f);
  const rd = (f) => { try { return existsSync(P(f)) ? readFileSync(P(f), "utf8") : ""; } catch { return ""; } };
  const json = (f, dflt) => { try { const t = rd(f); return t ? JSON.parse(t) : dflt; } catch { return dflt; } };
  const jsonl = (f) => rd(f).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });

  const st = json("status.json", null);
  const status = st ? pick(st, ["name", "address", "userid", "online", "joined", "ts", "web"]) : null;
  if (status) {
    status.express = Array.isArray(st.express) ? st.express.map((e) => pick(e, ["node", "ok"])) : [];
    status.ageSec = st.ts ? Math.round((Date.now() - Date.parse(st.ts)) / 1000) : null;
  }
  const advertised = st?.profile ? pick(st.profile, ["name", "description", "avatar"]) : null;
  const file = json("profile.json", {});
  const profile = {
    file: pick(file, ["name", "description", "avatar"]),
    advertised,
  };
  const av = advertised?.avatar ?? file.avatar;
  if (Number.isInteger(av)) profile.avatarUrl = punkImageUrl(av);

  const rawFriends = json("friends.json", []);
  const friends = (Array.isArray(rawFriends) ? rawFriends : []).map((f) => {
    const o = pick(f, ["userid", "address", "name", "description", "punkId", "status", "protoVersion",
      "platform", "appVersion", "requestedAt", "acceptedAt", "hello"]);
    o.id = f.userid ?? f.pubkey;
    // Same draw order as the SDK / Beagle apps: the friend's avatarUrl, then its CryptoPunks id.
    const url = typeof f.avatarUrl === "string" && /^https:\/\/[^\s"'<>]+$/.test(f.avatarUrl) ? f.avatarUrl : null;
    if (url) o.avatarUrl = url;
    else if (Number.isInteger(f.punkId)) o.avatarUrl = punkImageUrl(f.punkId);
    return o;
  });
  const byKey = new Map();
  for (const f of rawFriends ?? []) for (const k of [f.pubkey, f.userid, f.address]) if (k) byKey.set(k, f.userid ?? f.pubkey);
  const friendOf = (k) => (k && (byKey.get(k) ?? byKey.get(toUserid(k)))) ?? (k ? toUserid(k) : k);

  // Incoming requests that have not become a friend yet (latest per sender).
  const accepted = new Set(friends.filter((f) => f.status !== "requested").map((f) => f.id));
  const reqs = new Map();
  for (const r of jsonl("requests.jsonl")) {
    if (!r?.from) continue;
    const id = friendOf(r.from);
    if (accepted.has(id)) continue;
    reqs.set(id, { from: r.from, userid: id, hello: r.hello ?? "", ts: r.ts,
      ...pick(r, ["name", "description", "punkId", "avatarUrl"]) });
  }
  const requests = [...reqs.values()];

  // Chats: inbox (in) + outbox sends (out) joined with their receipts.
  const chats = {};
  const add = (id, m) => { (chats[id] ??= []).push(m); };
  // seq = position among the parseable inbox lines, the same count `mesh inbox` keeps in .inbox.read.
  const seen = Number(rd(".inbox.read")) || 0;
  jsonl("inbox.jsonl").filter(Boolean).forEach((m, seq) => {
    if (m?.from) add(friendOf(m.from), { dir: "in", ts: m.ts, text: String(m.text ?? ""), via: m.via, seq, unread: seq >= seen });
  });
  const receipts = new Map(); for (const r of jsonl("sent.jsonl")) if (r && Number.isInteger(r.line)) receipts.set(r.line, r);
  const dead = new Map(); for (const r of jsonl("deadletter.jsonl")) if (r && Number.isInteger(r.line)) dead.set(r.line, r);
  const ostate = json(".outbox.state.json", { queue: [] });
  const pending = new Map(); for (const j of ostate.queue ?? []) if (Number.isInteger(j.line)) pending.set(j.line, j);
  // Line numbers match outbox.mjs: non-empty lines, counted from 0.
  const lines = rd("outbox.jsonl").split("\n").filter(Boolean);
  lines.forEach((l, line) => {
    let c; try { c = JSON.parse(l); } catch { return; }
    if (c?.type !== "send" || !c.to) return;
    const r = receipts.get(line), d = dead.get(line), p = pending.get(line);
    const m = { dir: "out", text: String(c.text ?? ""), line };
    if (r) { m.ts = r.ts; m.state = r.delivery; }
    else if (d) { m.ts = d.ts; m.state = "failed"; m.error = String(d.error ?? ""); }
    else if (p) { m.ts = new Date(p.firstAt).toISOString(); m.state = "pending"; if (p.lastError) m.error = String(p.lastError); }
    else m.state = "unknown";
    add(friendOf(c.to), m);
  });
  for (const id of Object.keys(chats)) {
    chats[id].sort((a, b) => (Date.parse(a.ts ?? "") || 0) - (Date.parse(b.ts ?? "") || 0));
    if (chats[id].length > maxPerChat) chats[id] = chats[id].slice(-maxPerChat);
  }
  return { status, profile, friends, requests, chats, generatedAt: new Date().toISOString() };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-mesh</title>
<style>
:root{color-scheme:light dark;--b:#8884;--m:#888}
body{font:14px/1.45 system-ui,sans-serif;margin:0;display:grid;grid-template-columns:300px 1fr;height:100vh}
aside{border-right:1px solid var(--b);overflow:auto;padding:12px}
main{display:flex;flex-direction:column;overflow:hidden}
h1{font-size:16px;margin:0 0 4px}h2{font-size:12px;text-transform:uppercase;color:var(--m);margin:16px 0 6px}
.mono{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;color:var(--m)}
.av{width:36px;height:36px;border-radius:6px;background:#638596;image-rendering:pixelated;flex:none}
.row{display:flex;gap:8px;align-items:center;padding:6px;border-radius:6px;cursor:pointer}
.row:hover,.row.sel{background:#8882}.grow{flex:1;min-width:0}.nm{font-weight:600;overflow:hidden;text-overflow:ellipsis}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px;background:#999}.online{background:#2a2}.requested{background:#c90}
#head{padding:12px;border-bottom:1px solid var(--b)}#msgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:6px}
.msg{max-width:70%;padding:6px 10px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}
.in{align-self:flex-start;background:#8882}.out{align-self:flex-end;background:#2a6ad633}
.meta{font-size:11px;color:var(--m);margin-top:2px}.empty{color:var(--m);padding:12px}
.req{padding:6px;border:1px dashed var(--b);border-radius:6px;margin-bottom:6px}
</style></head><body>
<aside>
  <div id="me"></div>
  <h2>Friends</h2><div id="friends"></div>
  <h2>Pending requests</h2><div id="requests"></div>
  <p class="mono">Read-only view. Use the <code>mesh</code> CLI to send, accept or change the profile.</p>
</aside>
<main><div id="head"></div><div id="msgs"><div class="empty">Select a friend.</div></div></main>
<script>
const $=(id)=>document.getElementById(id);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
const avatar=(url)=>{if(!url)return el("div","av");const i=el("img","av");i.alt="";i.referrerPolicy="no-referrer";i.onerror=()=>i.replaceWith(el("div","av"));i.src=url;return i;};
const when=(ts)=>ts?new Date(ts).toLocaleString():"";
let sel=null,last=null;
function render(s){
  last=s;
  const me=$("me");me.replaceChildren();
  const top=el("div","row");top.style.cursor="default";
  top.append(avatar(s.profile.avatarUrl));
  const t=el("div","grow");
  const adv=s.profile.advertised||{};const name=adv.name||s.profile.file.name||(s.status&&s.status.name)||"agent";
  t.append(el("h1",null,name));t.append(el("div",null,adv.description??s.profile.file.description??""));
  top.append(t);me.append(top);
  if(s.status){
    const st=s.status;
    me.append(el("div",null,(st.online&&st.ageSec!=null&&st.ageSec<120?"● daemon running":"○ daemon not running")+(st.joined?", joined":"")+(st.ageSec!=null?" · heartbeat "+st.ageSec+"s ago":"")));
    me.append(el("div","mono","address "+st.address));me.append(el("div","mono","userid "+st.userid));
  } else me.append(el("div",null,"daemon not started (no status.json)"));
  const fl=$("friends");fl.replaceChildren();
  if(!s.friends.length)fl.append(el("div","empty","no friends yet"));
  for(const f of s.friends){
    const r=el("div","row"+(f.id===sel?" sel":""));r.onclick=()=>{sel=f.id;render(last);};
    r.append(avatar(f.avatarUrl));
    const g=el("div","grow");const n=el("div","nm");const d=el("span","dot "+f.status);n.append(d,document.createTextNode(f.name||f.id));
    g.append(n);g.append(el("div","mono",f.status+(f.description?" · "+f.description:"")));
    const c=(s.chats[f.id]||[]).length;if(c)g.append(el("div","meta",c+" messages"));
    r.append(g);fl.append(r);
  }
  const rq=$("requests");rq.replaceChildren();
  if(!s.requests.length)rq.append(el("div","empty","none"));
  for(const q of s.requests){const b=el("div","req");b.append(el("div",null,q.hello||"(no message)"));b.append(el("div","mono",q.userid));b.append(el("div","meta",when(q.ts)+" · accept with: mesh accept "+q.userid));rq.append(b);}
  const head=$("head"),box=$("msgs");
  const f=s.friends.find(x=>x.id===sel);
  const ids=new Set(s.friends.map(x=>x.id));
  head.replaceChildren();box.replaceChildren();
  if(!sel){box.append(el("div","empty","Select a friend."));return;}
  head.append(el("h1",null,f?(f.name||f.id):sel));head.append(el("div","mono",sel));
  const msgs=s.chats[sel]||[];
  if(!msgs.length)box.append(el("div","empty","no messages"));
  for(const m of msgs){const b=el("div","msg "+m.dir,m.text);b.append(el("div","meta",when(m.ts)+(m.dir==="in"?(m.via&&m.via!=="online"?" · via "+m.via:""):" · "+m.state+(m.error?" ("+m.error+")":""))));box.append(b);}
  box.scrollTop=box.scrollHeight;
}
async function tick(){try{const r=await fetch("/api/state",{cache:"no-store"});render(await r.json());}catch(e){}}
tick();setInterval(tick,3000);
</script></body></html>`;

// ---- Beagle UI host ------------------------------------------------------------------------

const require = createRequire(import.meta.url);
// URL path -> [package, file inside it]. Resolved through the package's main entry, because
// beagle-ui and react do not export package.json / umd/ (paths only, nothing is loaded here).
const ASSETS = {
  "/vendor/react.js": ["react", "umd/react.production.min.js"],
  "/vendor/react-dom.js": ["react-dom", "umd/react-dom.production.min.js"],
  "/vendor/beagle-ui.js": ["@decentnetwork/beagle-ui", null],
  "/vendor/chat-components.js": ["@decentnetwork/chat-components", null],
};
const assetCache = new Map();
function asset(path) {
  if (assetCache.has(path)) return assetCache.get(path);
  const [pkg, rel] = ASSETS[path];
  const main = require.resolve(pkg);
  let file = main;
  if (rel) {
    let dir = dirname(main);
    while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
    file = join(dir, rel);
  }
  const body = readFileSync(file);
  assetCache.set(path, body);
  return body;
}

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>agent-mesh</title>
<style>
*{box-sizing:border-box}html,body{margin:0;padding:0;height:100%}
body{background:oklch(0.165 0.012 264);font-family:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;-webkit-font-smoothing:antialiased;overflow:hidden}
#root{width:100%;height:100%}button{font-family:inherit}input{font-family:inherit}
input::placeholder{color:var(--faint)}input:focus{border-color:var(--accent)!important}
::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:var(--line);border-radius:8px;border:2px solid transparent;background-clip:padding-box}
.dk-md{white-space:normal}.dk-md p{margin:0}.dk-md p+p,.dk-md p+ul,.dk-md p+ol,.dk-md p+pre,.dk-md ul+p,.dk-md ol+p,.dk-md pre+p{margin-top:.5em}
.dk-md h1,.dk-md h2,.dk-md h3,.dk-md h4{margin:0 0 .35em;font-size:1em;line-height:1.25;font-weight:800}
.dk-md ul,.dk-md ol{margin:.25em 0;padding-left:1.35em}.dk-md li{margin:.15em 0}
.dk-md code{font-size:.92em;background:rgba(0,0,0,.18);border-radius:4px;padding:.08em .3em}
.dk-md pre{margin:.45em 0 0;padding:8px 10px;overflow:auto;border-radius:8px;background:rgba(0,0,0,.22)}
.dk-md pre code{display:block;background:transparent;padding:0;white-space:pre}
.dk-md a{color:inherit;text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}
@keyframes dkpulse{0%{transform:scale(.9);opacity:.7}70%{transform:scale(1.5);opacity:0}100%{opacity:0}}
#mesh-ro{position:fixed;right:10px;bottom:8px;z-index:9999;font:11px ui-monospace,monospace;color:#9aa4b2;background:#0d1117cc;border:1px solid #30363d;border-radius:6px;padding:3px 8px}
#mesh-ro a{color:inherit}
</style></head><body><div id="root"></div>
<div id="mesh-ro">agent-mesh · read-only · reply with mesh send &lt;userid&gt; "…" · <a href="/simple">simple view</a></div>
<script src="/vendor/react.js"></script>
<script src="/vendor/react-dom.js"></script>
<script type="module" src="/boot.js"></script>
</body></html>`;

const BOOT = `import * as ChatComponents from "/vendor/chat-components.js";
window.ChatComponents = ChatComponents;
const { mount, setUiHost } = await import("/vendor/beagle-ui.js");
// The simple Beagle: Chat and Profile only (no Apps, no People = Names/Here/Discover, no Network),
// no assistant, no beagles.eth writes, no wallet binding. This host only shows the agent's state.
setUiHost({ hostTabs: ["chat", "profile"], hostAssistant: false, hostEnsWrite: false, hostWalletBind: false });
mount(document.getElementById("root"));
`;

const msNum = (ts) => (typeof ts === "number" ? ts : Date.parse(ts ?? "")) || 0;
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), today = new Date();
  if (d.toDateString() === today.toDateString()) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date(today.getTime() - 86400000).toDateString()) return "Yest";
  if (today - d < 7 * 86400000) return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}`;
}

/** One message in the shape beagle-ui's chat reads (see its data-ipc.jsx). */
function beagleMsg(m) {
  if (m.dir === "in") return { id: `i${m.seq}`, ts: msNum(m.ts), dir: "in", text: m.text, via: m.via === "online" ? "online" : "offline" };
  const o = { id: `o${m.line}`, ts: msNum(m.ts), dir: "out", text: m.text };
  if (m.state === "pending" || m.state === "unknown") o.status = "queued";
  else if (m.state === "failed") { o.status = "failed"; o.error = m.error; }
  else { o.status = "sent"; o.via = m.state === "offline" ? "offline" : "online"; o.confirmed = m.state === "acked" || m.state === "offline"; }
  return o;
}

/** GET /api/desktop: who I am, my friends, pending requests. */
export function buildDesktop(home) {
  const s = buildState(home);
  const st = s.status ?? {};
  const adv = s.profile.advertised ?? {};
  const fileP = s.profile.file ?? {};
  const fresh = st.ageSec != null && st.ageSec <= 90 && st.online;
  const name = adv.name || fileP.name || st.name || "agent";
  const avatar = Number.isInteger(adv.avatar) ? adv.avatar : Number.isInteger(fileP.avatar) ? fileP.avatar : null;
  const me = {
    name, handle: `${name}@decentnetwork`, description: adv.description ?? fileP.description ?? "",
    userId: st.userid ?? "", carrier: st.address ?? "", netKey: st.userid ?? "", ip: "",
    online: !!(fresh && st.joined), lan: false, backend: "agent-mesh", lanVer: "", peerVer: "", webrtcVer: "",
    verFromBackend: false, channel: "", wire: "163", isExit: false, exitRegion: null, autoAccept: null,
    avatarUrl: null, ens: "", punkId: avatar,
  };
  const peers = s.friends.map((f) => {
    const msgs = s.chats[f.id] ?? [];
    const last = msgs[msgs.length - 1];
    const lastTs = last ? msNum(last.ts) : 0;
    return {
      id: f.id, alias: f.name || null, userId: f.id, address: f.address || "",
      online: f.status === "online", pending: f.status === "requested" && !f.acceptedAt,
      via: null, ping: null, ip: "", agent: false,
      unread: msgs.filter((m) => m.dir === "in" && m.unread).length,
      lastMsg: last ? (last.dir === "out" ? "you: " : "") + last.text : "",
      lastTime: fmtTime(lastTs), lastTs, lastDir: last?.dir ?? null,
      acceptedAt: f.acceptedAt ?? 0, requestedAt: f.requestedAt ?? 0, wire: "163",
      // The friend's own avatarUrl only; for a punk, beagle-ui draws the punk itself.
      avatarUrl: f.avatarUrl && !f.avatarUrl.includes("larvalabs.com/cryptopunks/") ? f.avatarUrl : null,
      punkId: Number.isInteger(f.punkId) ? f.punkId : null,
      platform: f.platform ?? null, appVersion: f.appVersion ?? null,
    };
  });
  const requests = s.requests.map((r) => ({
    id: r.userid, carrier: r.from, userid: r.userid, name: r.name ?? "", descr: r.description ?? "",
    hello: r.hello ?? "", via: "mesh", time: fmtTime(msNum(r.ts)),
    punkId: Number.isInteger(r.punkId) ? r.punkId : null, avatarUrl: r.avatarUrl ?? null,
  }));
  return { me, peers, requests, exits: [], activeExit: null, exitFeature: null, routeFallback: null, exitsSupported: false };
}

/** GET /api/chat-history?peer=&limit=&before=: one page of one conversation, oldest first. */
export function buildChatHistory(home, query) {
  const peer = query.get("peer") ?? "";
  const lim = Number(query.get("limit") ?? 200);
  const limit = Number.isFinite(lim) && lim > 0 ? Math.min(lim, 1000) : 200;
  const before = Number(query.get("before")) || 0;
  const all = (buildState(home, { maxPerChat: Infinity }).chats[peer] ?? []).map(beagleMsg);
  const page = (before ? all.filter((m) => m.ts < before) : all).slice(-limit);
  return { chats: { [peer]: page } };
}

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
const CSP_APP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src https: data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CSP_SIMPLE = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const READ_ONLY = { ok: false, error: "read-only view: reply from a terminal with mesh send <userid> \"…\" (accept with mesh accept <userid>)" };

/** Create (not listen) the server. */
export function createWebServer({ home }) {
  return createServer((req, res) => {
    const send = (code, type, body, csp = CSP_APP) => {
      res.writeHead(code, { "Content-Type": type, ...BASE_HEADERS, "Content-Security-Policy": csp });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const json = (code, o) => send(code, "application/json", JSON.stringify(o));
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(403, "text/plain", "forbidden host\n");
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (req.method === "POST" && path.startsWith("/api/")) {
      // Nothing is written. Answered as JSON so the UI shows the reason instead of a parse error.
      req.resume();
      return json(200, READ_ONLY);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "read-only\n");
    try {
      if (path === "/" || path === "/index.html") return send(200, "text/html; charset=utf-8", SHELL);
      if (path === "/boot.js") return send(200, "text/javascript; charset=utf-8", BOOT);
      if (ASSETS[path]) return send(200, "text/javascript; charset=utf-8", asset(path));
      if (path === "/simple") return send(200, "text/html; charset=utf-8", PAGE, CSP_SIMPLE);
      if (path === "/api/state") return json(200, buildState(home));
      if (path === "/api/desktop") return json(200, buildDesktop(home));
      if (path === "/api/chat-history") return json(200, buildChatHistory(home, url.searchParams));
      const punk = /^\/api\/punk\/(\d{1,4})$/.exec(path);
      if (punk) return json(200, { ok: true, punk: { id: Number(punk[1]), image: punkImageUrl(Number(punk[1])) } });
      if (path.startsWith("/api/")) return json(200, { ok: false, unsupported: true, error: "not available in the agent-mesh web view" });
    } catch (e) { return json(500, { ok: false, error: e.message }); }
    return send(404, "text/plain", "not found\n");
  });
}

/** Listen on 127.0.0.1:<port>. Resolves { server, port, close }. */
export function startWebServer({ home, port = DEFAULT_WEB_PORT }) {
  const server = createWebServer({ home });
  return new Promise((resolve, reject) => {
    server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`port ${port} is in use (try --port <n>)`) : e));
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      resolve({ server, port: p, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
