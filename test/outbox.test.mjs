// Outbox pump tests with a stand-in peer (no network). Run: npm test
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutbox as create } from "../outbox.mjs";

// Every pump a test starts is stopped afterwards, even when an assertion fails.
const live = [];
const createOutbox = (o) => { const ob = create(o); live.push(ob); return ob; };
afterEach(() => { for (const ob of live.splice(0)) ob.stop(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 4000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(10); }
  throw new Error(`timed out waiting for ${what}`);
}
const jsonl = (file) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function home() {
  const dir = mkdtempSync(join(tmpdir(), "mesh-outbox-"));
  const put = (...cmds) => { for (const c of cmds) appendFileSync(join(dir, "outbox.jsonl"), (typeof c === "string" ? c : JSON.stringify(c)) + "\n"); };
  return { dir, put, sent: () => jsonl(join(dir, "sent.jsonl")), dead: () => jsonl(join(dir, "deadletter.jsonl")), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const v2 = (pubkey, status = "online") => ({ pubkey, status, acceptedAt: 1, protoVersion: 2 });

// A peer double: records every call; each method's behaviour is overridable.
function fakePeer(friends, impl = {}) {
  const calls = [];
  const rec = (fn, args, run) => { const c = { fn, ...args, at: Date.now(), done: false }; calls.push(c); return Promise.resolve().then(run).finally(() => { c.done = true; c.end = Date.now(); }); };
  return {
    calls,
    friends: () => friends.map((f) => ({ ...f })),
    sendTextUntilAck: (to, text, o) => rec("untilAck", { to, text, deliveryId: o?.deliveryId }, () => (impl.untilAck ?? (async () => ({ deliveryId: o?.deliveryId })))(to, text, o)),
    sendTextViaExpress: (to, text, o) => rec("express", { to, text, deliveryId: o?.deliveryId }, () => (impl.express ?? (async () => ({ delivery: "offline" })))(to, text, o)),
    sendText: (to, text) => rec("sendText", { to, text }, () => (impl.sendText ?? (async () => ({ delivery: "acked" })))(to, text)),
    sendFriendRequest: (to, hello) => rec("friend", { to, hello }, () => (impl.friend ?? (async () => {}))(to, hello)),
    acceptFriendRequest: (to) => rec("accept", { to }, () => (impl.accept ?? (async () => {}))(to)),
  };
}
const fast = { tickMs: 20, retryBaseMs: 100, retryMaxMs: 400, ackTimeoutMs: 300, ackRetryMs: 100 };

test("the 6c100f7 pump re-sends a slow line on every tick (the bug this replaces)", async () => {
  // The old loop, verbatim in shape: async setInterval body, shared cursor, no guard.
  const peer = fakePeer([v2(B)], { untilAck: () => sleep(400) });
  const lines = [{ type: "send", to: B, text: "one slow message" }];
  let cursor = 0;
  const t = setInterval(async () => {
    for (; cursor < lines.length; cursor++) await peer.sendTextUntilAck(lines[cursor].to, lines[cursor].text, {});
  }, 20);
  await sleep(500); clearInterval(t); await sleep(450);
  console.log(`    old pump: ${peer.calls.length} sends of one line`);
  assert.ok(peer.calls.length > 5);
});

test("a slow send goes out once, not once per tick", async () => {
  const h = home();
  const peer = fakePeer([v2(B)], { untilAck: async (_t, _x, o) => { await sleep(400); return { deliveryId: o.deliveryId }; } });
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start(); h.put({ type: "send", to: B, text: "one slow message" });
  await until(() => h.sent().length === 1, 4000, "receipt");
  await sleep(200); ob.stop();
  console.log(`    new pump: ${peer.calls.length} send(s) during ~${Math.round(400 / fast.tickMs)} ticks`);
  assert.equal(peer.calls.length, 1);
  assert.deepEqual({ line: h.sent()[0].line, delivery: h.sent()[0].delivery, attempts: h.sent()[0].attempts }, { line: 0, delivery: "acked", attempts: 1 });
  h.done();
});

test("a friend that is offline goes to Express once, with the line's deliveryId", async () => {
  const h = home();
  const peer = fakePeer([v2(B, "offline")]);
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start(); h.put({ type: "send", to: B, text: "while you were away" });
  await until(() => h.sent().length === 1);
  await sleep(100); ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.fn), ["express"]);
  assert.equal(h.sent()[0].delivery, "offline");
  assert.equal(peer.calls[0].deliveryId, h.sent()[0].deliveryId);
  h.done();
});

test("a friend that looks online but never ACKs falls back to Express with the same deliveryId", async () => {
  const h = home();
  const peer = fakePeer([v2(B)], { untilAck: async () => { await sleep(300); throw new Error("text delivery ACK timed out"); } });
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start(); h.put({ type: "send", to: B, text: "are you there?" });
  await until(() => h.sent().length === 1);
  await sleep(100); ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.fn), ["untilAck", "express"]);
  assert.equal(peer.calls[0].deliveryId, peer.calls[1].deliveryId);
  assert.equal(h.sent()[0].attempts, 1);
  h.done();
});

test("an offline friend never blocks messages to other friends (no Express at all)", async () => {
  const h = home();
  // B's daemon is gone and there is no Express to fall back to: every attempt to B fails.
  const peer = fakePeer([v2(B), v2(C)], { untilAck: async (to, _x, o) => {
    if (to === B) { await sleep(50); throw new Error("text delivery ACK timed out"); }
    return { deliveryId: o.deliveryId };
  } });
  const ob = createOutbox({ peer, home: h.dir, hasExpress: false, ...fast });
  const t0 = Date.now();
  ob.start();
  h.put({ type: "send", to: B, text: "b1" }, { type: "send", to: C, text: "c1" }, { type: "send", to: B, text: "b2" }, { type: "send", to: C, text: "c2" });
  await until(() => h.sent().filter((r) => r.to === C).length === 2, 2000, "both C lines");
  await sleep(600); ob.stop();
  const toB = peer.calls.filter((c) => c.to === B);
  console.log(`    C: ${h.sent().length} lines sent; B (unreachable, no Express): ${toB.length} attempts in ~${Math.round((Date.now() - t0) / fast.tickMs)} ticks, still queued`);
  assert.ok(toB.length >= 2, "B is retried");
  assert.deepEqual(h.sent().map((r) => r.line), [1, 3]);
  assert.ok(toB.every((c) => c.text === "b1"), "b2 waits behind b1 (per-friend order)");
  assert.ok(toB.length <= 5, `backs off instead of retrying every tick (got ${toB.length})`);
  assert.deepEqual(ob.pending().map((j) => j.line), [0, 2]);
  h.done();
});

test("retries back off and keep the same deliveryId", async () => {
  const h = home();
  let n = 0;
  const peer = fakePeer([v2(B)], { untilAck: async (_t, _x, o) => { if (++n < 3) throw new Error("transient"); return { deliveryId: o.deliveryId }; } });
  const ob = createOutbox({ peer, home: h.dir, hasExpress: false, ...fast });
  ob.start(); h.put({ type: "send", to: B, text: "third time lucky" });
  await until(() => h.sent().length === 1, 4000);
  ob.stop();
  const [a, b, c] = peer.calls;
  assert.equal(peer.calls.length, 3);
  assert.equal(new Set(peer.calls.map((x) => x.deliveryId)).size, 1);
  assert.ok(b.at - a.at >= 80 && c.at - b.at >= 160, `gaps ${b.at - a.at} ms, ${c.at - b.at} ms`);
  assert.equal(h.sent()[0].attempts, 3);
  h.done();
});

test("lines to one friend go in order, one at a time", async () => {
  const h = home();
  const peer = fakePeer([v2(B)], { untilAck: async (_t, text, o) => { await sleep(text === "first" ? 200 : 10); return { deliveryId: o.deliveryId }; } });
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start(); h.put({ type: "send", to: B, text: "first" }, { type: "send", to: B, text: "second" });
  await until(() => h.sent().length === 2);
  ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.text), ["first", "second"]);
  assert.ok(peer.calls[1].at >= peer.calls[0].end);
  h.done();
});

test("a line waiting only for its confirmation does not hold the next line to that friend", async () => {
  const h = home();
  // A friend whose protocol version is unknown: sendText resolves only after the SDK's confirmation wait.
  const peer = fakePeer([{ pubkey: B, status: "online" }], { sendText: () => sleep(800).then(() => ({ delivery: "accepted" })) });
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast, pipelineAfterMs: 100 });
  ob.start(); h.put(...["one", "two", "three"].map((text) => ({ type: "send", to: B, text })));
  await until(() => h.sent().length === 3, 4000);
  await sleep(100); ob.stop();
  const starts = peer.calls.map((c) => c.at - peer.calls[0].at);
  console.log(`    3 lines to one friend, 800 ms each: started at ${starts.join(", ")} ms`);
  assert.deepEqual(peer.calls.map((c) => c.text), ["one", "two", "three"]);
  assert.ok(starts[1] >= 90 && starts[2] < 800, `pipelined: ${starts}`);
  assert.deepEqual(h.sent().map((r) => r.attempts), [1, 1, 1]);
  h.done();
});

test("a restart sends nothing twice and resumes a queued line with its deliveryId", async () => {
  const h = home();
  const p1 = fakePeer([v2(B), v2(C, "offline")]);
  const ob1 = createOutbox({ peer: p1, home: h.dir, hasExpress: false, ...fast });
  ob1.start(); h.put({ type: "send", to: B, text: "done before restart" }, { type: "send", to: C, text: "pending at restart" });
  await until(() => h.sent().length === 1 && ob1.pending()[0]?.attempts >= 1);
  ob1.stop(); await sleep(50);
  const pendingId = ob1.pending()[0].deliveryId;
  const p2 = fakePeer([v2(B), v2(C)]); // C is back
  const ob2 = createOutbox({ peer: p2, home: h.dir, hasExpress: false, ...fast });
  ob2.start();
  await until(() => h.sent().length === 2, 4000);
  ob2.stop();
  assert.deepEqual(p2.calls.map((c) => c.text), ["pending at restart"]);
  assert.equal(p2.calls[0].deliveryId, pendingId);
  h.done();
});

test("upgrading from 0.1.x resumes at .outbox.cursor; a fresh outbox skips old history", async () => {
  const h = home();
  h.put({ type: "send", to: B, text: "old 0" }, { type: "send", to: B, text: "old 1" }, { type: "send", to: B, text: "unsent 2" });
  writeFileSync(join(h.dir, ".outbox.cursor"), "2");
  const peer = fakePeer([v2(B)]);
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start(); await until(() => h.sent().length === 1); await sleep(100); ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.text), ["unsent 2"]);
  h.done();

  const h2 = home();
  h2.put({ type: "send", to: B, text: "history" });
  const peer2 = fakePeer([v2(B)]);
  const ob2 = createOutbox({ peer: peer2, home: h2.dir, hasExpress: true, ...fast });
  ob2.start(); await sleep(150); ob2.stop();
  assert.equal(peer2.calls.length, 0);
  h2.done();
});

test("bad lines go to deadletter.jsonl at once and do not hold up the rest", async () => {
  const h = home();
  const peer = fakePeer([v2(C)]);
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start();
  h.put("{not json", { type: "send", to: B, text: "to a stranger" }, { type: "nope", to: C }, { type: "send", to: C, text: "still sent" });
  await until(() => h.sent().length === 1 && h.dead().length === 3);
  await sleep(200); ob.stop();
  const dead = h.dead().sort((a, b) => a.line - b.line);
  assert.deepEqual(dead.map((d) => d.line), [0, 1, 2]);
  assert.match(dead[1].error, /Not a friend/);
  assert.equal(h.sent()[0].line, 3);
  assert.deepEqual(peer.calls.map((c) => c.text), ["still sent"]);
  h.done();
});

test("a send waits (backing off) until the friend request is accepted", async () => {
  const h = home();
  const friends = [{ pubkey: B, status: "requested" }];
  const peer = fakePeer(friends);
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start(); h.put({ type: "send", to: B, text: "after you accept" });
  await sleep(300);
  assert.equal(peer.calls.length, 0);
  assert.equal(h.dead().length, 0);
  Object.assign(friends[0], { status: "online", acceptedAt: Date.now(), protoVersion: 2 });
  await until(() => h.sent().length === 1, 4000);
  ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.fn), ["untilAck"]);
  h.done();
});

test("a friend marked online without acceptedAt (an SDK quirk) still gets Express mail once offline", async () => {
  const h = home();
  const peer = fakePeer([{ pubkey: B, status: "offline", protoVersion: 2 }]);
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start(); h.put({ type: "send", to: B, text: "mail for later" });
  await until(() => h.sent().length === 1); ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.fn), ["express"]);
  h.done();
});

test("a phone (legacy peer) uses sendText; 'accepted' is final, never resent", async () => {
  const h = home();
  const peer = fakePeer([{ pubkey: B, status: "online", acceptedAt: 1 }], { sendText: async () => ({ delivery: "accepted" }) });
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start(); h.put({ type: "send", to: B, text: "hi phone" });
  await until(() => h.sent().length === 1); await sleep(200); ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.fn), ["sendText"]);
  assert.equal(h.sent()[0].delivery, "accepted");
  h.done();
});

test("friend and accept lines run once; a friend request keys on the address's userid", async () => {
  const h = home();
  const ADDR = `${B}-address`;
  let releaseFriend;
  const peer = fakePeer([v2(B)], { friend: () => new Promise((r) => { releaseFriend = r; }) });
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, toUserid: (s) => (s === ADDR ? B : s), ...fast, pipelineAfterMs: 50 });
  ob.start(); h.put({ type: "friend", to: ADDR, hello: "hi" }, { type: "send", to: B, text: "after the request" }, { type: "accept", to: C });
  await until(() => peer.calls.some((c) => c.fn === "accept"));
  await sleep(200);
  assert.deepEqual(peer.calls.map((c) => c.fn), ["friend", "accept"], "the send to B waits for the friend request to B");
  releaseFriend();
  await until(() => h.sent().length === 3);
  ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.fn), ["friend", "accept", "untilAck"]);
  assert.deepEqual(h.sent().map((r) => r.delivery).sort(), ["accepted", "acked", "dispatched"]);
  h.done();
});

test("a half-written last line waits for its newline", async () => {
  const h = home();
  const peer = fakePeer([v2(B)]);
  const ob = createOutbox({ peer, home: h.dir, hasExpress: true, ...fast });
  ob.start();
  appendFileSync(join(h.dir, "outbox.jsonl"), '{"type":"send","to":"' + B + '","te');
  await sleep(150);
  assert.equal(peer.calls.length, 0);
  appendFileSync(join(h.dir, "outbox.jsonl"), 'xt":"whole now"}\n');
  await until(() => h.sent().length === 1); ob.stop();
  assert.deepEqual(peer.calls.map((c) => c.text), ["whole now"]);
  assert.equal(h.dead().length, 0);
  h.done();
});
