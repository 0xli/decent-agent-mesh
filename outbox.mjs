// outbox.mjs — the daemon's outbox pump.
//
// The agent appends one command per line to outbox.jsonl. The pump reads new
// lines into a queue (one job per line), runs each job, and records the result.
//
//   - A line is sent once. A job is retried only after an attempt has failed,
//     after a back-off (5 s, 10 s, 20 s … capped at 5 min); never on every tick.
//   - Lines to one recipient start in outbox order; different recipients run in
//     parallel, so one slow or offline friend never holds up anyone else. The
//     next line to the same recipient starts once the previous one has been in
//     flight pipelineAfterMs (3 s): by then it has left and is only waiting for
//     a confirmation (the SDK can wait 20 s for one). A friend request holds the
//     lines behind it until it has gone out. A job is never run twice at once.
//   - Every text job carries a deliveryId that is fixed when the line is read
//     and kept across retries and restarts, so a retry (or an SDK retransmit)
//     is recognised by the receiving SDK as the same message.
//   - Results: sent.jsonl (one line per finished job) and deadletter.jsonl
//     (jobs that can never succeed, or still fail after giveUpMs).
//
// State lives in .outbox.state.json {cursor, queue}, written atomically.
// .outbox.cursor is still written (the number of lines read) for old tooling.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const OUTBOX_DEFAULTS = {
  tickMs: 1500,
  retryBaseMs: 5_000,
  retryMaxMs: 5 * 60_000,
  giveUpMs: 72 * 3600_000, // a line still failing after 3 days goes to deadletter.jsonl
  ackTimeoutMs: 20_000,    // live send to a friend that looks online: wait this long for its ACK
  ackRetryMs: 10_000,      // SDK retransmit interval (same deliveryId) inside that window
  pipelineAfterMs: 3_000,  // then the next line to the same recipient may start
  maxPerFriend: 4,         // jobs in flight per recipient
  maxParallel: 16,         // jobs in flight in all
};

// Errors no retry can fix: the job goes straight to deadletter.jsonl.
// (Bad address / userid, not a friend, oversized payload. An Express or network error is never here.)
const PERMANENT = /Not a friend|invalid base58|base58 value is required|must decode to|must be \d+ bytes|checksum mismatch|nospam must be|exceeds bulk limit|1\.\.1373 bytes|payload must be/i;

const permanent = (message) => Object.assign(new Error(message), { permanent: true });
const isJson = (s) => { try { JSON.parse(s); return true; } catch { return false; } };
const newDeliveryId = () => `${Date.now().toString(36)}-${randomBytes(9).toString("base64url")}`;

/**
 * @param {object} o
 * @param {object} o.peer        a started @decentnetwork/peer Peer (or a test double)
 * @param {string} o.home        the agent directory (DECENT_PEER_HOME)
 * @param {boolean} o.hasExpress whether the peer was created with Express nodes
 * @param {(s:string)=>string} [o.toUserid] address -> userid (identity for anything else)
 * @param {(m:string)=>void} [o.log]
 * @param {string} [o.name]      agent name, for the default friend-request hello
 */
export function createOutbox({ peer, home, hasExpress, toUserid = (s) => s, log = () => {}, name = "agent", ...overrides }) {
  const cfg = { ...OUTBOX_DEFAULTS, ...overrides };
  const P = (f) => join(home, f);
  const OUTBOX = P("outbox.jsonl");
  const STATE = P(".outbox.state.json");
  const CURSOR = P(".outbox.cursor");
  const iso = () => new Date().toISOString();
  const running = new Set(); // jobs with an attempt in progress
  let timer;

  function readLines() {
    if (!existsSync(OUTBOX)) return [];
    const parts = readFileSync(OUTBOX, "utf8").split("\n");
    const tail = parts.pop(); // "" when the file ends with a newline
    const lines = parts.filter(Boolean);
    // A last line without "\n" counts only if it is complete JSON; a half-written one waits.
    if (tail && isJson(tail)) lines.push(tail);
    return lines;
  }

  function load() {
    if (existsSync(STATE)) {
      try {
        const s = JSON.parse(readFileSync(STATE, "utf8"));
        if (Number.isInteger(s.cursor) && Array.isArray(s.queue)) return s;
      } catch (e) { log(`outbox: ${STATE} unreadable (${e.message}); rebuilding from .outbox.cursor`); }
    }
    // Upgrade from 0.1.x (only a cursor was kept), or the first run ever: a fresh
    // outbox skips history that existed before the daemon did.
    const n = readLines().length;
    let cursor = n;
    if (existsSync(CURSOR)) cursor = Math.min(Math.max(0, Number(readFileSync(CURSOR, "utf8")) || 0), n);
    return { cursor, queue: [] };
  }

  const state = load();

  function save() {
    const tmp = `${STATE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, STATE);
    writeFileSync(CURSOR, String(state.cursor));
  }
  save();

  const keyOf = (cmd) => { try { return toUserid(String(cmd.to ?? "")); } catch { return String(cmd.to ?? ""); } };
  const label = (job) => `line ${job.line} ${job.cmd.type} -> ${job.cmd.to}`;

  function deadLetter(entry, error) {
    appendFileSync(P("deadletter.jsonl"), JSON.stringify({ ts: iso(), ...entry, error }) + "\n");
    log(`DEAD-LETTER line ${entry.line}: ${error}`);
  }

  // New lines -> jobs. Synchronous, so two ticks can never read the same line twice.
  function ingest() {
    const lines = readLines();
    let changed = false;
    if (state.cursor > lines.length) {
      // Truncated or rotated: what was below the cursor was already read. Do NOT go back to 0
      // (that replayed a whole outbox once: 141 duplicates).
      log(`outbox shrank to ${lines.length} lines (cursor was ${state.cursor}); continuing from its end`);
      state.cursor = lines.length;
      changed = true;
    }
    for (; state.cursor < lines.length; state.cursor++) {
      changed = true;
      const line = state.cursor;
      let cmd;
      try { cmd = JSON.parse(lines[line]); } catch { deadLetter({ line, raw: lines[line] }, "not valid JSON"); continue; }
      if (!cmd || typeof cmd !== "object") { deadLetter({ line, raw: lines[line] }, "not a command object"); continue; }
      const job = { line, cmd, key: keyOf(cmd), attempts: 0, firstAt: Date.now(), nextAt: 0 };
      if (cmd.type === "send") job.deliveryId = newDeliveryId();
      state.queue.push(job);
    }
    if (changed) save();
  }

  async function sendText(to, text, deliveryId) {
    if (!text) throw permanent("empty text");
    const f = peer.friends().find((x) => x.pubkey === to || x.userid === to);
    if (!f) throw permanent(`Not a friend: ${to}`);
    // Our request is out and the friend has never come online: a message now would be dropped by
    // the other side. Wait (with back-off) for the accept. (Not `acceptedAt`: some SDK paths mark a
    // friend online without setting it, and such a friend must still get Express mail later.)
    if (f.status === "requested") throw new Error("waiting for the friend to accept the request");
    const id = f.pubkey;
    if ((f.protoVersion ?? 0) >= 2) {
      // A JS peer that speaks the delivery envelope: we can ask for an ACK, and the receiving SDK
      // drops a second copy with the same deliveryId.
      if (f.status === "online") {
        try {
          await peer.sendTextUntilAck(id, text, { deliveryId, timeoutMs: cfg.ackTimeoutMs, retryIntervalMs: cfg.ackRetryMs });
          return "acked";
        } catch (e) {
          if (!hasExpress) throw e;
          log(`no ACK from ${id} within ${cfg.ackTimeoutMs / 1000}s (${e.message}); posting to Express`);
        }
      }
      if (!hasExpress) throw new Error("friend is offline and no Express node is configured");
      await peer.sendTextViaExpress(id, text, { deliveryId });
      return "offline";
    }
    // A Beagle phone app, or a peer whose protocol version is not known yet: the SDK picks live or
    // Express itself. "accepted" (live, unconfirmed) is final: resending a copy that did arrive
    // would show it twice.
    const r = await peer.sendText(id, text);
    return r?.delivery ?? "accepted";
  }

  async function execute(job) {
    const { cmd } = job;
    switch (cmd.type) {
      case "send":
        return sendText(job.key, typeof cmd.text === "string" ? cmd.text : String(cmd.text ?? ""), job.deliveryId);
      case "friend":
        await peer.sendFriendRequest(cmd.to, cmd.hello ?? `hello from ${name}`);
        return "dispatched";
      case "accept":
        await peer.acceptFriendRequest(job.key);
        return "accepted";
      default:
        throw permanent(`unknown command type "${cmd.type}"`);
    }
  }

  const backoff = (attempt) =>
    Math.round(Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** (attempt - 1)) * (0.8 + Math.random() * 0.4));

  const drop = (job) => { const i = state.queue.indexOf(job); if (i >= 0) state.queue.splice(i, 1); };

  async function run(job) {
    running.add(job);
    job.attempts += 1;
    job.lastAttemptAt = Date.now();
    log(`ATTEMPT ${job.attempts} ${label(job)}`);
    try {
      const delivery = await execute(job);
      drop(job);
      const receipt = { ts: iso(), line: job.line, type: job.cmd.type, to: job.cmd.to, delivery, attempts: job.attempts };
      if (job.deliveryId) receipt.deliveryId = job.deliveryId;
      appendFileSync(P("sent.jsonl"), JSON.stringify(receipt) + "\n");
      const what = job.cmd.type === "send" ? `: ${String(job.cmd.text).slice(0, 80)}` : "";
      log(`SENT ${label(job)} [${delivery}]${what}`);
    } catch (e) {
      const msg = e?.message ?? String(e);
      job.lastError = msg;
      if (e?.permanent || PERMANENT.test(msg)) {
        drop(job);
        deadLetter({ line: job.line, cmd: job.cmd, attempts: job.attempts }, msg);
      } else if (Date.now() - job.firstAt >= cfg.giveUpMs) {
        drop(job);
        deadLetter({ line: job.line, cmd: job.cmd, attempts: job.attempts }, `gave up after ${job.attempts} attempts: ${msg}`);
      } else {
        const wait = backoff(job.attempts);
        job.nextAt = Date.now() + wait;
        log(`RETRY ${label(job)} in ${(wait / 1000).toFixed(1)}s (attempt ${job.attempts} failed: ${msg})`);
      }
    } finally {
      running.delete(job);
      save();
    }
  }

  function tick() {
    try { ingest(); } catch (e) { log(`outbox read failed: ${e.message}`); }
    const now = Date.now();
    const perKey = new Map();
    for (const job of running) perKey.set(job.key, (perKey.get(job.key) ?? 0) + 1);
    let total = running.size;
    const held = new Set(); // recipients whose next line must wait this tick
    for (const job of state.queue) {
      if (held.has(job.key)) continue;
      if (running.has(job)) {
        // Later lines to this recipient wait unless this is a text past its first seconds (then it
        // is only waiting for a confirmation). A friend request always holds them: the friend
        // record a send needs exists only once the request has gone out.
        if (job.cmd.type !== "send" || now - job.lastAttemptAt < cfg.pipelineAfterMs || perKey.get(job.key) >= cfg.maxPerFriend) held.add(job.key);
        continue;
      }
      held.add(job.key); // at most one new start per recipient per tick; a backing-off line holds the rest
      if (job.nextAt > now || total >= cfg.maxParallel) continue;
      total += 1;
      perKey.set(job.key, (perKey.get(job.key) ?? 0) + 1);
      void run(job);
    }
  }

  return {
    start() { if (!timer) { tick(); timer = setInterval(tick, cfg.tickMs); } },
    stop() { clearInterval(timer); timer = undefined; },
    tick,
    pending: () => state.queue.map((j) => ({ ...j })),
    running: () => [...running].map((j) => j.line),
  };
}
