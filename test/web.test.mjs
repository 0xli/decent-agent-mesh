// Web view tests: loopback only, read-only, never serves key material. No network beyond 127.0.0.1.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildState, startWebServer } from "../web.mjs";

const SECRET = "SECRET-KEY-MATERIAL-7f3a9c";
const ME = "4AsdtNLUwnu9uXgGP4Jcwv97EVakhs5pG6ZMaqiDycy5";
const BOB = "BobBobBobBobBobBobBobBobBobBobBobBobBobBob1";
const CAROL = "CarolCarolCarolCarolCarolCarolCarolCarol12";
const DAVE = "DaveDaveDaveDaveDaveDaveDaveDaveDaveDave123";

let home, srv;
const put = (f, v) => writeFileSync(join(home, f), typeof v === "string" ? v : JSON.stringify(v));
const line = (f, o) => appendFileSync(join(home, f), JSON.stringify(o) + "\n");

before(async () => {
  home = mkdtempSync(join(tmpdir(), "mesh-web-"));
  put("peer.save", SECRET);
  put("config.json", { secretish: SECRET });
  put("status.json", { name: "me", address: "ADDR", userid: ME, online: true, joined: true, ts: new Date().toISOString(),
    express: [{ node: "lens.beagle.chat:443", ok: true, doorbell: SECRET }], profile: { name: "Me Bot", description: "hi", avatar: 2 }, pid: 1, web: "http://127.0.0.1:8770/" });
  put("profile.json", { name: "Me Bot", description: "hi", avatar: 2 });
  put("friends.json", [
    { pubkey: BOB, userid: BOB, name: "Bob", description: "bob desc", punkId: 7804, status: "online", protoVersion: 2, dhtPubkey: "DHT", secretField: SECRET },
    { pubkey: CAROL, userid: CAROL, name: "Carol", status: "offline", acceptedAt: 1, punkId: 5, avatarUrl: "https://ens-gateway.beaglechat.workers.dev/avatar/carol.beagles.eth?v=1" },
    { pubkey: "Pending1", userid: "Pending1", status: "requested", requestedAt: 1 },
  ]);
  line("requests.jsonl", { ts: "2026-11-22T10:00:00.000Z", from: BOB, hello: "old request, now a friend" });
  line("requests.jsonl", { ts: "2026-11-22T11:00:00.000Z", from: DAVE, hello: "hi, I am Dave" });
  line("inbox.jsonl", { ts: "2026-11-22T12:00:01.000Z", from: BOB, text: "pong <b>bold</b>", via: "online" });
  line("inbox.jsonl", { ts: "2026-11-22T12:05:00.000Z", from: CAROL, text: "from express", via: "express" });
  line("outbox.jsonl", { type: "friend", to: "BOBADDR", hello: "hi" });            // line 0
  line("outbox.jsonl", { type: "send", to: BOB, text: "ping" });                   // line 1
  line("outbox.jsonl", { type: "send", to: CAROL, text: "still waiting" });        // line 2
  line("outbox.jsonl", { type: "send", to: "Nobody", text: "dead" });              // line 3
  line("sent.jsonl", { ts: "2026-11-22T12:00:00.000Z", line: 0, type: "friend", delivery: "dispatched" });
  line("sent.jsonl", { ts: "2026-11-22T12:00:00.500Z", line: 1, type: "send", delivery: "acked" });
  line("deadletter.jsonl", { ts: "2026-11-22T12:00:02.000Z", line: 3, error: "Not a friend: Nobody" });
  put(".outbox.state.json", { cursor: 4, queue: [{ line: 2, firstAt: Date.parse("2026-11-22T12:04:00.000Z"), lastError: "offline" }] });
  srv = await startWebServer({ home, port: 0 });
});
after(async () => { await srv?.close(); rmSync(home, { recursive: true, force: true }); });

function get(path, { method = "GET", host } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path, method, headers: host ? { Host: host } : {} }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject); req.end();
  });
}

test("binds 127.0.0.1 only", () => {
  assert.equal(srv.server.address().address, "127.0.0.1");
});

test("state: identity, profile, friends, pending requests, chats", () => {
  const s = buildState(home);
  assert.equal(s.status.userid, ME);
  assert.equal(s.profile.advertised.name, "Me Bot");
  assert.equal(s.profile.avatarUrl, "https://www.larvalabs.com/cryptopunks/cryptopunk0002.png");
  assert.deepEqual(s.friends.map((f) => [f.name ?? f.id, f.status]), [["Bob", "online"], ["Carol", "offline"], ["Pending1", "requested"]]);
  assert.equal(s.friends[0].avatarUrl, "https://www.larvalabs.com/cryptopunks/cryptopunk7804.png");
  assert.equal(s.friends[1].avatarUrl, "https://ens-gateway.beaglechat.workers.dev/avatar/carol.beagles.eth?v=1", "avatarUrl wins over punkId");
  assert.equal(s.friends[2].avatarUrl, undefined);
  assert.deepEqual(s.requests.map((r) => r.userid), [DAVE], "a request from someone who is now a friend is not pending");
  assert.deepEqual(s.chats[BOB].map((m) => [m.dir, m.text, m.state ?? m.via]), [["out", "ping", "acked"], ["in", "pong <b>bold</b>", "online"]]);
  assert.deepEqual(s.chats[CAROL].map((m) => [m.dir, m.state ?? m.via]), [["out", "pending"], ["in", "express"]]);
  assert.equal(s.chats.Nobody[0].state, "failed");
  assert.equal(s.chats.BOBADDR, undefined, "friend requests are not chat messages");
});

test("never serves key material or unlisted fields", async () => {
  for (const p of ["/", "/api/state", "/peer.save", "/../peer.save", "/config.json", "/%2e%2e/peer.save"]) {
    const r = await get(p);
    assert.ok(!r.body.includes(SECRET), `${p} leaked key material`);
  }
  const s = JSON.parse((await get("/api/state")).body);
  assert.equal(s.friends[0].dhtPubkey, undefined);
  assert.equal(s.friends[0].secretField, undefined);
  assert.equal((await get("/peer.save")).status, 404);
});

test("read-only, no CORS, rejects foreign Host headers", async () => {
  const ok = await get("/api/state");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["access-control-allow-origin"], undefined);
  assert.match(ok.headers["content-security-policy"], /default-src 'none'/);
  assert.equal((await get("/", { host: "localhost:8770" })).status, 200);
  assert.equal((await get("/api/state", { host: "evil.example:8770" })).status, 403);
  assert.equal((await get("/api/state", { host: "192.168.1.5:8770" })).status, 403);
  for (const m of ["POST", "PUT", "DELETE"]) assert.equal((await get("/api/state", { method: m })).status, 405);
  const before = readFileSync(join(home, "outbox.jsonl"), "utf8");
  await get("/api/state?send=1", { method: "POST" });
  assert.equal(readFileSync(join(home, "outbox.jsonl"), "utf8"), before);
});

test("page renders text with textContent (no innerHTML)", async () => {
  const page = (await get("/")).body;
  assert.ok(!page.includes("innerHTML"));
  assert.match(page, /textContent/);
});
