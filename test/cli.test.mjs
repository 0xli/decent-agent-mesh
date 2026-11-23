// CLI tests for inbox/peek --json, watch and hook. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MESH = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "mesh");
const run = (home, args, input) => spawnSync(process.execPath, [MESH, ...args], { env: { ...process.env, DECENT_PEER_HOME: home }, encoding: "utf8", input });
const msg = (home, from, text) => appendFileSync(join(home, "inbox.jsonl"), JSON.stringify({ ts: new Date().toISOString(), from, text, via: "online" }) + "\n");

test("inbox --json / peek --json: same unread set, inbox marks read", () => {
  const home = mkdtempSync(join(tmpdir(), "mesh-cli-"));
  try {
    assert.deepEqual(JSON.parse(run(home, ["inbox", "--json"]).stdout), []);
    msg(home, "U1", "one"); msg(home, "U2", "two");
    const peek = JSON.parse(run(home, ["peek", "--json"]).stdout);
    assert.deepEqual(peek.map((m) => [m.from, m.text, m.via]), [["U1", "one", "online"], ["U2", "two", "online"]]);
    assert.equal(JSON.parse(run(home, ["peek", "--json"]).stdout).length, 2, "peek does not mark read");
    assert.equal(JSON.parse(run(home, ["inbox", "--json"]).stdout).length, 2);
    assert.deepEqual(JSON.parse(run(home, ["inbox", "--json"]).stdout), [], "inbox --json marked them read");
    assert.match(run(home, ["inbox"]).stdout, /inbox empty/);
    msg(home, "U3", "three");
    assert.match(run(home, ["inbox"]).stdout, /three[\s\S]*\[1 read\]/);
    assert.deepEqual(JSON.parse(run(home, ["peek", "--json"]).stdout), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("watch blocks until a message arrives, does not mark it read; --timeout exits 2", async () => {
  const home = mkdtempSync(join(tmpdir(), "mesh-cli-"));
  try {
    const t = run(home, ["watch", "--interval", "1", "--timeout", "1"]);
    assert.equal(t.status, 2);
    const p = spawn(process.execPath, [MESH, "watch", "--interval", "1", "--json"], { env: { ...process.env, DECENT_PEER_HOME: home } });
    let out = ""; p.stdout.on("data", (d) => (out += d));
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(p.exitCode, null, "still waiting");
    msg(home, "U1", "wake up");
    const code = await new Promise((r) => p.on("exit", r));
    assert.equal(code, 0);
    assert.equal(JSON.parse(out)[0].text, "wake up");
    assert.equal(JSON.parse(run(home, ["peek", "--json"]).stdout).length, 1, "still unread");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("hook: empty inbox = silent; unread = block once and mark read; stop_hook_active = silent", () => {
  const home = mkdtempSync(join(tmpdir(), "mesh-cli-"));
  try {
    let r = run(home, ["hook"], "{}");
    assert.equal(r.status, 0); assert.equal(r.stdout, "");
    msg(home, "U1", "hello agent");
    r = run(home, ["hook"], JSON.stringify({ stop_hook_active: true }));
    assert.equal(r.stdout, "", "respects stop_hook_active");
    r = run(home, ["hook"], "{}");
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /hello agent/);
    assert.equal(run(home, ["hook"], "{}").stdout, "", "marked read: next stop is not blocked");
    const path = run(home, ["hook", "--path"]).stdout.trim();
    assert.ok(path.endsWith("stop-hook.sh") && existsSync(path));
    assert.match(readFileSync(path, "utf8"), /stop_hook_active/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a daemon started outside this mesh (older copy / pm2, no pid file) blocks start, shows in status", () => {
  const home = mkdtempSync(join(tmpdir(), "mesh-cli-"));
  try {
    writeFileSync(join(home, "status.json"), JSON.stringify({ name: "agent", address: "A", userid: "U", online: true, joined: true, ts: new Date().toISOString() }));
    let r = run(home, ["start"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already running .*not one this mesh started/s);
    assert.ok(!existsSync(join(home, "peerd.pid")), "no second daemon was spawned");
    assert.match(run(home, ["status"]).stdout, /running \(started outside this mesh/);
    assert.equal(run(home, ["stop"]).status, 1);
    // peerd itself refuses too (pm2 starting the new version while the old one still runs)
    const p = spawnSync(process.execPath, [join(dirname(MESH), "peerd.mjs")], { env: { ...process.env, DECENT_PEER_HOME: home }, encoding: "utf8", timeout: 20000 });
    assert.equal(p.status, 3, p.stderr);
    assert.match(p.stderr, /already running/);
    // a stale heartbeat (dead daemon) does not block
    writeFileSync(join(home, "status.json"), JSON.stringify({ online: true, joined: true, ts: new Date(Date.now() - 300_000).toISOString() }));
    assert.match(run(home, ["status"]).stdout, /daemon\s+not running/);
    // a stopped 0.2 daemon (online false) does not block
    writeFileSync(join(home, "status.json"), JSON.stringify({ online: false, ts: new Date().toISOString(), pid: 999999 }));
    assert.match(run(home, ["status"]).stdout, /daemon\s+not running/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
