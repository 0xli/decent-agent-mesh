#!/usr/bin/env node
// Live end-to-end check on the public network, with three throwaway agents.
//
//   node test/live-e2e.mjs [scratch-dir]      (npm run test:live)
//
// alpha befriends beta and gamma, pings both, then beta's daemon is stopped.
// alpha queues b1, g1, b2, g2, and g3 halfway through beta's outage (DOWN_MS,
// default 45 s). Expected:
//   - g1, g2, g3 reach gamma while beta is down (an offline friend blocks no one),
//   - b1 and b2 go to Express and reach beta after it restarts,
//   - every outbox line has exactly one receipt in sent.jsonl, and no receiver
//     drops a duplicate copy.
// Uses only fresh identities in the scratch dir (never ~/.decent-peer), turns the
// push-gateway doorbell registration off, and stops every daemon it starts.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "mesh-live-")));
mkdirSync(ROOT, { recursive: true });
const RUN = Date.now().toString(36);
const t0 = Date.now();
const T = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const say = (m) => console.log(`[${T()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const jsonl = (f) => read(f).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
async function until(what, cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(500); }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}

const agents = {};
for (const name of ["alpha", "beta", "gamma"]) {
  const home = join(ROOT, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (home === join(process.env.HOME ?? "", ".decent-peer")) throw new Error("refusing to use ~/.decent-peer");
  agents[name] = { name, home, f: (x) => join(home, x), proc: null };
}
const procs = new Set();
function startDaemon(a) {
  const out = openSync(a.f("peerd.log"), "a");
  const p = spawn(process.execPath, [join(REPO, "peerd.mjs")], {
    cwd: REPO, stdio: ["ignore", out, out],
    env: { ...process.env, DECENT_PEER_HOME: a.home, AGENT_NAME: a.name, DECENT_EXPRESS_PUSH_REGISTER: "0" },
  });
  a.proc = p; a.startedAt = Date.now(); procs.add(p);
  p.on("exit", () => procs.delete(p));
  say(`${a.name}: daemon started (pid ${p.pid})`);
}
async function stopDaemon(a) {
  const p = a.proc; if (!p || p.exitCode !== null) return;
  p.kill("SIGTERM");
  const done = await Promise.race([new Promise((r) => p.once("exit", () => r(true))), sleep(8000).then(() => false)]);
  if (!done) p.kill("SIGKILL");
  say(`${a.name}: daemon stopped`);
}
async function stopAll() { await Promise.all(Object.values(agents).map(stopDaemon)); }
process.on("SIGINT", async () => { await stopAll(); process.exit(130); });

const mesh = (a, ...args) => execFileSync(process.execPath, [join(REPO, "mesh"), ...args], { env: { ...process.env, DECENT_PEER_HOME: a.home }, encoding: "utf8" }).trim();
const status = (a) => { try { return JSON.parse(read(a.f("status.json"))); } catch { return null; } };
const joined = (a) => { const s = status(a); return s?.joined && Date.parse(s.ts) >= a.startedAt - 1000 ? s : null; };
const inbox = (a) => jsonl(a.f("inbox.jsonl"));
const friendOf = (a, userid) => { try { return JSON.parse(read(a.f("friends.json"))).find((f) => f.pubkey === userid); } catch { return undefined; } };
const queued = {}; // text -> time queued

async function main() {
  say(`scratch ${ROOT}; repo ${REPO}; run ${RUN}`);
  const { alpha, beta, gamma } = agents;
  Object.values(agents).forEach(startDaemon);
  for (const a of Object.values(agents)) {
    const s = await until(`${a.name} to join`, () => joined(a), 240_000);
    a.userid = s.userid; a.address = s.address;
    say(`${a.name}: joined, userid ${a.userid}, express ${JSON.stringify(s.express)}`);
  }
  writeFileSync(beta.f("allow.txt"), alpha.userid + "\n");
  writeFileSync(gamma.f("allow.txt"), alpha.userid + "\n");
  writeFileSync(alpha.f("allow.txt"), `${beta.userid}\n${gamma.userid}\n`);

  say(mesh(alpha, "friend", beta.address, `hi beta ${RUN}`));
  say(mesh(alpha, "friend", gamma.address, `hi gamma ${RUN}`));
  for (const a of [beta, gamma]) {
    await until(`${a.name} to auto-accept alpha`, () => read(a.f("peerd.log")).includes(`AUTO-ACCEPTED ${alpha.userid}`), 240_000);
    say(`${a.name}: accepted alpha's request`);
  }
  for (const a of [beta, gamma]) {
    await until(`alpha to see ${a.name} online`, () => friendOf(alpha, a.userid)?.status === "online", 240_000);
    say(`alpha: ${a.name} is an online friend (protoVersion ${friendOf(alpha, a.userid).protoVersion ?? "?"})`);
  }

  const send = (a, text) => { queued[text] = Date.now(); say(mesh(alpha, "send", a.userid, text)); };
  const got = (a, text) => inbox(a).find((m) => m.text === text);
  send(beta, `ping beta ${RUN}`);
  send(gamma, `ping gamma ${RUN}`);
  for (const a of [beta, gamma]) {
    const m = await until(`${a.name} to receive the ping`, () => got(a, `ping ${a.name} ${RUN}`), 120_000);
    say(`${a.name}: got the ping (${m.via}) ${((Date.parse(m.ts) - queued[m.text]) / 1000).toFixed(1)}s after it was queued`);
  }

  // Beta goes away. alpha does not know yet: its session still looks live for up to ~32 s.
  await stopDaemon(beta);
  const downAt = Date.now();
  const B1 = `b1 while beta is down ${RUN}`, G1 = `g1 ${RUN}`, B2 = `b2 while beta is down ${RUN}`, G2 = `g2 ${RUN}`;
  const G3 = `g3 during the outage ${RUN}`;
  send(beta, B1); send(gamma, G1); send(beta, B2); send(gamma, G2);
  for (const text of [G1, G2]) {
    const m = await until(`gamma to receive "${text}"`, () => got(gamma, text), 90_000);
    say(`gamma: got "${text}" (${m.via}) ${((Date.parse(m.ts) - queued[text]) / 1000).toFixed(1)}s after it was queued, beta still down`);
  }
  const receipts = () => jsonl(alpha.f("sent.jsonl"));
  for (const text of [B1, B2]) {
    const r = await until(`a receipt for "${text}"`, () => receipts().find((x) => jsonl(alpha.f("outbox.jsonl"))[x.line]?.text === text), 120_000);
    say(`alpha: "${text}" -> ${r.delivery} after ${((Date.parse(r.ts) - queued[text]) / 1000).toFixed(1)}s, attempt ${r.attempts}`);
  }

  // Keep beta down a while (DOWN_MS, default 45 s) so alpha's session to it really times out,
  // and keep talking to gamma meanwhile.
  const downMs = Number(process.env.DOWN_MS ?? 45_000);
  await sleep(Math.max(0, downAt + downMs / 2 - Date.now()));
  send(gamma, G3);
  const m3 = await until(`gamma to receive "${G3}"`, () => got(gamma, G3), 90_000);
  say(`gamma: got "${G3}" (${m3.via}) ${((Date.parse(m3.ts) - queued[G3]) / 1000).toFixed(1)}s after it was queued, beta still down`);
  await sleep(Math.max(0, downAt + downMs - Date.now()));
  say(`alpha sees beta as: ${friendOf(alpha, beta.userid)?.status}`);
  startDaemon(beta);
  for (const text of [B1, B2]) {
    const m = await until(`beta to receive "${text}" after restart`, () => got(beta, text), 240_000);
    say(`beta: got "${text}" (${m.via}) ${((Date.parse(m.ts) - beta.startedAt) / 1000).toFixed(1)}s after its restart`);
  }
  await sleep(15_000); // let any stray copy arrive before counting

  // ---- verdict
  const outbox = jsonl(alpha.f("outbox.jsonl"));
  const rs = receipts();
  const perLine = outbox.map((cmd, line) => ({ line, cmd, receipts: rs.filter((r) => r.line === line) }));
  const attempts = {};
  for (const m of read(alpha.f("peerd.log")).matchAll(/ATTEMPT (\d+) line (\d+) /g)) attempts[m[2]] = Math.max(attempts[m[2]] ?? 0, Number(m[1]));
  console.log("\nalpha outbox line | command | receipts | delivery | attempts");
  for (const p of perLine) {
    const what = p.cmd.type === "send" ? `send "${p.cmd.text}"` : `${p.cmd.type}`;
    console.log(`  ${p.line} | ${what} | ${p.receipts.length} | ${p.receipts.map((r) => r.delivery).join(",")} | ${attempts[p.line] ?? 0}`);
  }
  const count = (a, text) => inbox(a).filter((m) => m.text === text).length;
  const dedups = (a) => (read(a.f("peerd.log")).match(/DEDUP drop/g) ?? []).length;
  const checks = [
    ["every outbox line has exactly one receipt", perLine.every((p) => p.receipts.length === 1)],
    ["no deadletter", jsonl(alpha.f("deadletter.jsonl")).length === 0],
    ["gamma got g1, g2, g3 once each while beta was down", [G1, G2, G3].every((t) => count(gamma, t) === 1)],
    ["beta got b1, b2 once each, via Express", count(beta, B1) === 1 && count(beta, B2) === 1 && [B1, B2].every((t) => got(beta, t).via === "offline")],
    ["beta got b1 before b2", inbox(beta).findIndex((m) => m.text === B1) < inbox(beta).findIndex((m) => m.text === B2)],
    ["no receiver dropped a duplicate copy", dedups(beta) === 0 && dedups(gamma) === 0],
  ];
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  return checks.every(([, ok]) => ok);
}

let ok = false;
try { ok = await main(); }
catch (e) { say(`ERROR ${e.message}`); }
finally { await stopAll(); }
say(`logs and state: ${ROOT}/{alpha,beta,gamma}/`);
console.log(ok ? "\nLIVE E2E PASSED" : "\nLIVE E2E FAILED");
process.exit(ok ? 0 : 1);
