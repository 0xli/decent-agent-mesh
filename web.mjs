// web.mjs — a read-only local web view of one agent: identity, profile, friends,
// pending friend requests and each friend's chat.
//
//   mesh web [--port 8770]          serve it (foreground) for $DECENT_PEER_HOME
//   mesh start --web [--port 8770]  the daemon serves it as well
//
// Safety:
//   - binds 127.0.0.1 only; requests whose Host header is not 127.0.0.1/localhost are refused
//     (stops DNS-rebinding pages from reading it); no CORS headers; GET/HEAD only.
//   - it reads an allow-list of files and copies an allow-list of fields out of them. It never
//     opens peer.save (the private key) or config.json, and serves no files from disk.
//   - read-only: it never writes to outbox.jsonl or anything else.
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
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
    if (Number.isInteger(f.punkId)) o.avatarUrl = punkImageUrl(f.punkId);
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
    reqs.set(id, { from: r.from, userid: id, hello: r.hello ?? "", ts: r.ts });
  }
  const requests = [...reqs.values()];

  // Chats: inbox (in) + outbox sends (out) joined with their receipts.
  const chats = {};
  const add = (id, m) => { (chats[id] ??= []).push(m); };
  for (const m of jsonl("inbox.jsonl")) if (m?.from) add(friendOf(m.from), { dir: "in", ts: m.ts, text: String(m.text ?? ""), via: m.via });
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
const avatar=(url)=>{const i=el("img","av");i.alt="";i.referrerPolicy="no-referrer";if(url)i.src=url;return i;};
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

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https://cryptopunks.app; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Create (not listen) the server. */
export function createWebServer({ home }) {
  return createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type, ...SEC_HEADERS }); res.end(req.method === "HEAD" ? undefined : body); };
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(403, "text/plain", "forbidden host\n");
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "read-only\n");
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "/index.html") return send(200, "text/html; charset=utf-8", PAGE);
    if (path === "/api/state") {
      try { return send(200, "application/json", JSON.stringify(buildState(home))); }
      catch (e) { return send(500, "application/json", JSON.stringify({ error: e.message })); }
    }
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
