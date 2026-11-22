#!/usr/bin/env node
// peerd — always-on Decent peer daemon = an agent's P2P inbox/outbox.
// Pure JS, normal user privilege, messaging only (no TUN / virtual IP).
// Holds ONE warm Carrier connection so the agent never pays DHT-join latency
// per message. The agent interacts only with local files (no network in the
// agent's own commands):
//   inbox.jsonl     <- daemon appends every received text  {ts,from,text,via}
//   outbox.jsonl    -> agent appends commands; daemon sends them:
//                        {"type":"send","to":"<userid>","text":"..."}
//                        {"type":"friend","to":"<address>","hello":"..."}
//                        {"type":"accept","to":"<userid>"}
//   sent.jsonl      <- one receipt per finished outbox line {ts,line,type,to,delivery,attempts}
//   deadletter.jsonl <- outbox lines that can never be sent (bad id, not a friend, gave up)
//   requests.jsonl  <- daemon appends incoming friend requests {ts,from,hello}
//   friends.json    <- daemon snapshots peer.friends()
//   status.json     <- {name,address,userid,online,joined,express,profile,pid,web,ts}
//   profile.json    -> what friends see {name,description,avatar}; applied live (see profile.mjs)
//   peerd.pid       <- pid of the running daemon (one daemon per DECENT_PEER_HOME)
// Offline delivery: messages to a friend whose daemon is down go to the Express
// store-and-forward node (from https://beagle.chat/assets/bgservers.json) and are
// collected when it comes back.
// Trusted 2+-agent mesh: auto-accepts friend requests from IDs listed in
// ~/.decent-peer/allow.txt (one userid/address per line); others just logged.
//
// Env: DECENT_PEER_DIST (path to peer dist/index.js), DECENT_PEER_HOME
// (default ~/.decent-peer), AGENT_NAME (default display name), MESH_WEB_PORT
// (serve the read-only web view on 127.0.0.1:<port>; `mesh start --web` sets it).
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createOutbox } from "./outbox.mjs";
import { readProfile, toPeerOptions, validateProfile, watchProfile } from "./profile.mjs";

const HOME = process.env.DECENT_PEER_HOME || join(homedir(), ".decent-peer");
mkdirSync(HOME, { recursive: true });
const P = (f) => join(HOME, f);
const NAME = process.env.AGENT_NAME || "agent";
const now = () => new Date().toISOString();
const log = (m) => console.log(`[${now()}] ${m}`);

// One daemon per identity: two would pump the same outbox (every message twice) and split the inbox.
const PIDF = P("peerd.pid");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
if (existsSync(PIDF)) {
  const other = Number(readFileSync(PIDF, "utf8"));
  if (other && other !== process.pid && alive(other)) {
    console.error(`peerd already running for ${HOME} (pid ${other}); not starting a second one`);
    process.exit(3);
  }
}
writeFileSync(PIDF, String(process.pid));

process.on("unhandledRejection", (e) => log(`unhandledRejection: ${e?.message ?? e}`));
// Mesh bug #1 evidence: never exit silently — every death leaves a trace.
process.on("uncaughtException", (e) => { log(`uncaughtException: ${e?.stack ?? e}`); process.exit(1); });
const dropPid = () => { try { if (Number(readFileSync(PIDF, "utf8")) === process.pid) unlinkSync(PIDF); } catch {} };
process.on("exit", (code) => { dropPid(); try { log(`process exit code=${code}`); } catch {} });
// Registered before the network work, so `mesh stop` during a slow join still exits cleanly.
// Each step is guarded: what is not created yet (still in its TDZ) is skipped.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try { outbox.stop(); } catch {}
  try { profileWatch.stop(); } catch {}
  try { await peer.stop(); } catch {}
  try { writeStatus(false, false); } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Prefer the published npm package (portable to any Node machine); fall back to
// a local repo build only if DECENT_PEER_DIST is explicitly set.
let sdk;
try {
  sdk = await import("@decentnetwork/peer");
} catch (err) {
  if (!process.env.DECENT_PEER_DIST) throw err;
  sdk = await import(process.env.DECENT_PEER_DIST);
}
const { Peer, carrierIdFromAddress } = sdk;

// ~/.decent-peer/config.json may set "bootstrapNodes" and/or "expressNodes"
// (each [{host,port,pk}]). "expressNodes": [] turns offline delivery off.
const CONFIG = (() => {
  try { return existsSync(P("config.json")) ? JSON.parse(readFileSync(P("config.json"), "utf8")) : {}; }
  catch (e) { log(`config.json unreadable (${e.message}); using defaults`); return {}; }
})();

const BOOTSTRAPS = CONFIG.bootstrapNodes ?? [
  // Decent Network public DHT bootstrap nodes — geographically diverse so a
  // fresh peer can always find at least one.
  // US-East
  { host: "13.58.208.50", port: 33445, pk: "89vny8MrKdDKs7Uta9RdVmspPjnRMdwMmaiEW27pZ7gh" },
  { host: "18.216.102.47", port: 33445, pk: "G5z8MqiNDFTadFUPfMdYsYtkUDbX5mNCMVHMZtsCnFeb" },
  { host: "18.216.6.197", port: 33445, pk: "H8sqhRrQuJZ6iLtP2wanxt4LzdNrN2NNFnpPdq1uJ9n2" },
  // US-West
  { host: "54.193.141.205", port: 33445, pk: "7TfZWZNV8vnBxxWzJXuvKgX2QyKkLpg2oXx3LQ5tg8LW" },
  // Global
  { host: "154.64.235.176", port: 33445, pk: "GdNtV2N74fZnLjhH7NhQ18nGdxb1k8jRM9dQaK7WnxmL" },
  // Asia-Pacific; one on port 443 for networks that block 33445
  { host: "52.74.215.181", port: 33445, pk: "Xv6d34WaUw9bPn7YihzVAFw7D2igbQJZ3jwmzzfYVFV" },
  { host: "47.100.103.201", port: 33445, pk: "CX1XH419p4xJ5SV4KvDxBeKYSRdMJW9QpdWJY8owUxHd" },
  { host: "52.83.171.135", port: 443, pk: "5tuHgK1Q4CYf4K5PutsEPK5E3Z7cbtEBdx7LwmdzqXHL" },
  { host: "52.83.191.228", port: 33445, pk: "3khtxZo89SBScAMaHhTvD68pPHiKxgZT6hTCSZZVgNEm" },
];

// Express = the offline mailbox (HTTPS store-and-forward). @decentnetwork/peer has
// NO default: without expressNodes a message to an offline friend cannot be stored.
// Read the live list the Beagle apps use; fall back to the node it listed on 2026-11-12.
const SERVERS_URL = "https://beagle.chat/assets/bgservers.json";
const EXPRESS_FALLBACK = [{ host: "lens.beagle.chat", port: 443, pk: "ECbs4GxwGzxGerNkmqDJFibEmevu8jAXqAZtikccvD95" }];
const EXPRESS = await (async () => {
  if (Array.isArray(CONFIG.expressNodes)) return CONFIG.expressNodes;
  try {
    const list = await (await fetch(SERVERS_URL, { signal: AbortSignal.timeout(8000) })).json();
    const nodes = (list.expressNodes ?? [])
      .map((n) => ({ host: n.ipv4 ?? n.host, port: Number(n.port), pk: n.publicKey ?? n.pk }))
      .filter((n) => n.host && n.port && n.pk);
    if (nodes.length) return nodes;
    log(`${SERVERS_URL} lists no expressNodes; using the built-in one`);
  } catch (e) { log(`could not read ${SERVERS_URL} (${e.message}); using the built-in Express node`); }
  return EXPRESS_FALLBACK;
})();

const allow = () => existsSync(P("allow.txt"))
  ? readFileSync(P("allow.txt"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
  : [];

// Profile goes into Peer.create so the very first friend request already carries the name.
const PROFILE = (() => {
  try {
    const p = readProfile(HOME);
    const errs = validateProfile(p);
    if (errs.length) { log(`profile.json ignored: ${errs.join("; ")}`); return {}; }
    return p;
  } catch (e) { log(`profile.json unreadable (${e.message}); ignored`); return {}; }
})();
const DEFAULT_NAME = NAME; // $AGENT_NAME or "agent"

const peer = await Peer.create({
  keyFile: P("peer.save"), bootstrapNodes: BOOTSTRAPS, expressNodes: EXPRESS,
  compatibilityMode: "legacy", debugLabel: NAME, ...toPeerOptions(PROFILE, DEFAULT_NAME),
});
log(`express ${EXPRESS.length ? EXPRESS.map((n) => `${n.host}:${n.port}`).join(", ") : "off (config.json expressNodes: [])"}`);

// Handlers go in BEFORE start(): start() begins pulling Express, and a message
// pulled before onText exists would be lost.

// Receiver-side dedup (mesh bug #3): a peer that replays its outbox (cursor reset) re-delivers
// every old message. Drop an identical (from,text) seen within DEDUP_MS. PERSISTENT across restarts
// (.inbox.seen on disk) with a 48h window — the v1 in-memory-only version missed a replay that
// arrived AFTER a peerd restart (empty map). 48h > any legit gap between identical sends on this
// channel (reports carry dates/changing numbers), so no real message is lost.
const DEDUP_MS = 48 * 60 * 60 * 1000;
const SEENF = ".inbox.seen";
const _djb2 = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h.toString(36); };
let _seen = new Map();
try { if (existsSync(P(SEENF))) _seen = new Map(Object.entries(JSON.parse(readFileSync(P(SEENF), "utf8")))); } catch {}
const _persistSeen = () => { try { writeFileSync(P(SEENF), JSON.stringify(Object.fromEntries(_seen))); } catch {} };
peer.onText((msg) => {
  const key = _djb2(`${msg.pubkey}|${msg.text}`);
  const t = Date.now();
  for (const [k, ts] of _seen) if (t - ts > DEDUP_MS) _seen.delete(k);
  if (_seen.has(key)) { log(`DEDUP drop ${msg.pubkey}: ${msg.text.slice(0, 48)}`); return; }
  _seen.set(key, t); _persistSeen();
  const via = msg.via ?? "online";
  appendFileSync(P("inbox.jsonl"), JSON.stringify({ ts: now(), from: msg.pubkey, text: msg.text, via }) + "\n");
  log(`RECV ${msg.pubkey} (${via}): ${msg.text}`);
});
peer.onFriendRequest(async (req) => {
  const from = req.userid ?? req.pubkey;
  appendFileSync(P("requests.jsonl"), JSON.stringify({ ts: now(), from, hello: req.hello ?? "" }) + "\n");
  log(`FRIEND-REQ ${from} "${req.hello ?? ""}"`);
  if (allow().some((a) => from?.includes(a) || a.includes(from))) {
    try { await peer.acceptFriendRequest(req.pubkey); log(`AUTO-ACCEPTED ${from}`); }
    catch (e) { log(`accept failed: ${e.message}`); }
  }
});

await peer.start();
{
  const u = peer.userInfo();
  log(`PROFILE name="${u.name}" description="${u.description}" avatar=${u.punkId ?? "none"}`);
}

const expressStatus = () => {
  try { return (peer.expressHealth?.() ?? []).map((h) => ({ node: h.node, ok: h.fails === 0 && h.lastOkMs > 0, doorbell: h.doorbell })); }
  catch { return []; }
};
let WEB_PORT = null;
let JOINED = false;
const advertised = () => { try { const u = peer.userInfo(); return { name: u.name, description: u.description, avatar: u.punkId ?? null }; } catch { return null; } };
const writeStatus = (joined, online = true) => writeFileSync(P("status.json"), JSON.stringify(
  { name: NAME, address: peer.address(), userid: peer.userid(), online, joined, express: expressStatus(),
    profile: advertised(), pid: process.pid, web: WEB_PORT ? `http://127.0.0.1:${WEB_PORT}/` : null, ts: now() }, null, 2));
writeStatus(false);
// profile.json edits (`mesh profile ...`) are applied live and re-sent to every friend.
const profileWatch = watchProfile({ home: HOME, peer, defaultName: DEFAULT_NAME, log,
  onApply: () => { try { writeStatus(JOINED); } catch {} } });
log(`address ${peer.address()}`);
log(`userid  ${peer.userid()}`);

// Optional read-only web view (loopback only). It reads the same files `mesh` reads.
if (process.env.MESH_WEB_PORT) {
  try {
    const { startWebServer } = await import("./web.mjs");
    const srv = await startWebServer({ home: HOME, port: Number(process.env.MESH_WEB_PORT) });
    WEB_PORT = srv.port;
    log(`web view http://127.0.0.1:${WEB_PORT}/ (read-only, loopback only)`);
    writeStatus(false);
  } catch (e) { log(`web view not started: ${e.message}`); }
}

// Resilient join: a transient bootstrap timeout must NOT kill the daemon.
for (let attempt = 1; ; attempt++) {
  try { await peer.joinNetwork(); break; }
  catch (e) { log(`join attempt ${attempt} failed: ${e.message} — retrying in 10s`); await new Promise((r) => setTimeout(r, 10000)); }
}
for (let i = 0; i < 3; i++) { try { const n = await peer.announceSelf(45000); if (n.length) break; } catch (e) { log(`announce retry: ${e.message}`); } }
JOINED = true;
writeStatus(true);
log("joined + announced — inbox live");

// Heartbeat (mesh bug #3): a live daemon must refresh status.json ts, or
// monitoring reads a stale "joined true" from a wedged/dead process.
setInterval(() => { try { writeStatus(true); } catch {} }, 30000);

// re-announce so we stay reachable
setInterval(() => peer.announceSelf(20000).catch(() => {}), 120000);
const snapshotFriends = () => { try { writeFileSync(P("friends.json"), JSON.stringify(peer.friends(), null, 2)); } catch {} };
snapshotFriends();
setInterval(snapshotFriends, 30000);
// A friend's name/avatar/presence change shows in friends.json at once, not 30 s later.
peer.onFriendInfo?.(() => snapshotFriends());
peer.onFriendConnection?.(() => snapshotFriends());

// Outbox pump: each line becomes one job; sent once, retried with back-off only after a failure,
// one job at a time per recipient (see outbox.mjs). An offline friend's text goes to Express.
const toUserid = (s) => { try { return carrierIdFromAddress(s); } catch { return s; } };
const outbox = createOutbox({ peer, home: HOME, hasExpress: EXPRESS.length > 0, toUserid, log, name: NAME });
outbox.start();

