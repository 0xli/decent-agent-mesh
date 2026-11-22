#!/usr/bin/env node
// Clean-install end-to-end check on the live network (npm run test:install, ~2 min).
//
//   node test/install-e2e.mjs [scratch-dir] [--tarball <file.tgz>] [--from-npm <version>]
//
// 1. `npm pack` this repo (or take --tarball, or install @decentnetwork/agent-mesh@<version>
//    from the registry with --from-npm), then `npm i -g` it into an empty prefix with an empty HOME.
// 2. Two identities: alice in the default home ($HOME/.decent-peer) and bob in DECENT_PEER_HOME.
//    Each sets a profile with `mesh profile`, then `mesh start` (alice with --web).
// 3. Both reach "joined true"; alice friends bob, bob accepts; ping and pong; each sees the
//    other's name (and bob sees alice's description and avatar); a live profile change on alice
//    reaches bob; the web view shows bob and the chat and no key material.
// 4. `mesh stop` both. Never touches the real ~/.decent-peer.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const TARBALL = opt("--tarball");
const FROM_NPM = opt("--from-npm");
const ROOT = resolve(args[0] ?? mkdtempSync(join(tmpdir(), "mesh-install-")));
mkdirSync(ROOT, { recursive: true });
const LOG = join(ROOT, "install-e2e.log");
const t0 = Date.now();
const say = (m) => { const l = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`; console.log(l); appendFileSync(LOG, l + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await cond(); if (v) return v; await sleep(1000); }
  throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
}

const HOME = join(ROOT, "home");
const PREFIX = join(ROOT, "prefix");
mkdirSync(HOME, { recursive: true });
if (existsSync(join(HOME, ".decent-peer"))) throw new Error(`${HOME} is not empty; use a fresh scratch dir`);
const NODE_BIN = dirname(process.execPath);
const NPM = join(NODE_BIN, "npm");
const baseEnv = {
  PATH: `${join(PREFIX, "bin")}:${NODE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME, TMPDIR: process.env.TMPDIR ?? "/tmp",
  npm_config_cache: join(HOME, ".npm"), npm_config_userconfig: join(HOME, ".npmrc"), npm_config_update_notifier: "false",
  DECENT_EXPRESS_PUSH_REGISTER: "0", // throwaway identities: do not register with the push gateway
};
say(`scratch ${ROOT}`);
say(`node ${process.version}; empty HOME ${HOME}; npm prefix ${PREFIX}`);

let spec = TARBALL && resolve(TARBALL);
if (FROM_NPM) spec = `@decentnetwork/agent-mesh@${FROM_NPM}`;
if (!spec) {
  const out = execFileSync(NPM, ["pack", "--pack-destination", ROOT, "--json"], { cwd: REPO, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false" } });
  const info = JSON.parse(out)[0];
  spec = join(ROOT, info.filename);
  say(`packed ${info.filename} (${info.files.length} files, ${info.size} bytes): ${info.files.map((f) => f.path).join(" ")}`);
}
say(`npm i -g ${spec}`);
const inst = spawnSync(NPM, ["i", "-g", "--prefix", PREFIX, spec], { env: baseEnv, encoding: "utf8" });
appendFileSync(LOG, inst.stdout + inst.stderr);
if (inst.status !== 0) { say(`npm install failed:\n${inst.stdout}${inst.stderr}`); process.exit(1); }
say(inst.stdout.trim().split("\n").filter(Boolean).pop());
const MESH = join(PREFIX, "bin", "mesh");
const which = spawnSync("sh", ["-c", "command -v mesh"], { env: baseEnv, encoding: "utf8" }).stdout.trim();
say(`mesh on PATH: ${which}`);

const alice = { name: "alice", env: { ...baseEnv }, home: join(HOME, ".decent-peer") };
const bob = { name: "bob", env: { ...baseEnv, DECENT_PEER_HOME: join(HOME, "bob") }, home: join(HOME, "bob") };
const RUN = Date.now().toString(36);
const mesh = (a, ...cmd) => {
  const r = spawnSync("mesh", cmd, { env: a.env, encoding: "utf8" });
  const out = (r.stdout + r.stderr).trim();
  say(`${a.name}$ mesh ${cmd.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ")}${out ? "\n    " + out.replace(/\n/g, "\n    ") : ""}`);
  if (r.status !== 0) throw new Error(`mesh ${cmd[0]} failed (${r.status})`);
  return r.stdout;
};
const json = (a, f) => { try { return JSON.parse(readFileSync(join(a.home, f), "utf8")); } catch { return null; } };
const jsonl = (a, f) => { try { return readFileSync(join(a.home, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

let failed = false;
try {
  mesh(alice, "--help");
  mesh(alice, "profile", "--name", `Alice ${RUN}`, "--description", "install test agent", "--avatar", "2");
  mesh(bob, "profile", "--name", `Bob ${RUN}`);
  const free = spawnSync("sh", ["-c", "lsof -nP -iTCP:8770 -sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim() === "";
  const WEB = free ? 8770 : 8771 + Math.floor(Math.random() * 100);
  if (!free) say("port 8770 is in use on this machine; the web view uses " + WEB);
  mesh(alice, "start", "--web", ...(free ? [] : ["--port", String(WEB)]));
  mesh(bob, "start");
  for (const a of [alice, bob]) await until(`${a.name} joined`, () => json(a, "status.json")?.joined === true, 180_000);
  mesh(alice, "status");
  mesh(bob, "status");
  const A = json(alice, "status.json"), B = json(bob, "status.json");

  mesh(alice, "friend", B.address, `hello from alice ${RUN}`);
  await until("bob sees alice's request", () => jsonl(bob, "requests.jsonl").some((r) => r.from === A.userid), 240_000);
  mesh(bob, "requests");
  mesh(bob, "accept", A.userid);
  // Like test/live-e2e.mjs: ping once both sides see a live session (a text sent before that may
  // take the unconfirmed legacy path and be lost).
  await until("alice and bob online to each other", () =>
    (json(alice, "friends.json") ?? []).some((f) => f.userid === B.userid && f.status === "online") &&
    (json(bob, "friends.json") ?? []).some((f) => f.userid === A.userid && f.status === "online"), 240_000);
  say("alice and bob see each other online");
  mesh(alice, "friends");

  mesh(alice, "send", B.userid, `ping ${RUN}`);
  await until("bob gets the ping", () => jsonl(bob, "inbox.jsonl").some((m) => m.text === `ping ${RUN}`), 120_000);
  mesh(bob, "peek", "--json");
  mesh(bob, "inbox");
  mesh(bob, "send", A.userid, `pong ${RUN}`);
  await until("alice gets the pong", () => jsonl(alice, "inbox.jsonl").some((m) => m.text === `pong ${RUN}`), 120_000);
  mesh(alice, "inbox");

  const fA = () => (json(bob, "friends.json") ?? []).find((f) => f.userid === A.userid) ?? {};
  const fB = () => (json(alice, "friends.json") ?? []).find((f) => f.userid === B.userid) ?? {};
  await until("names on both sides", () => fA().name === `Alice ${RUN}` && fB().name === `Bob ${RUN}`, 90_000);
  say(`bob sees alice as name="${fA().name}" description="${fA().description}" punkId=${fA().punkId}`);
  say(`alice sees bob as name="${fB().name}"`);
  await until("bob sees alice's description and avatar", () => fA().description === "install test agent" && fA().punkId === 2, 60_000);

  mesh(alice, "profile", "--name", `Alice2 ${RUN}`, "--avatar", "7804");
  await until("bob sees alice's new name and avatar (live update)", () => fA().name === `Alice2 ${RUN}` && fA().punkId === 7804, 90_000);
  say(`after the live change bob sees alice as name="${fA().name}" punkId=${fA().punkId}`);

  const r = await fetch(`http://127.0.0.1:${WEB}/api/state`);
  const body = await r.text();
  const st = JSON.parse(body);
  const key = readFileSync(join(alice.home, "peer.save"));
  const keyLeak = body.includes(key.toString("base64")) || body.includes(key.toString("hex")) || body.includes(key.toString("latin1").slice(0, 32));
  const chat = st.chats[B.userid] ?? [];
  say(`web view ${r.status}: me="${st.profile.advertised?.name}" friends=${JSON.stringify(st.friends.map((f) => [f.name, f.status]))} chat with bob=${JSON.stringify(chat.map((m) => [m.dir, m.text, m.state ?? m.via]))} keyLeak=${keyLeak}`);
  if (!st.friends.some((f) => f.name === `Bob ${RUN}`) || !chat.some((m) => m.text === `ping ${RUN}`) || !chat.some((m) => m.text === `pong ${RUN}`) || keyLeak) throw new Error("web view is missing data or leaks the key");
  const html = await (await fetch(`http://127.0.0.1:${WEB}/`)).text();
  say(`web page ${html.length} bytes, title ${/<title>(.*?)<\/title>/.exec(html)?.[1]}`);
  say("PASS");
} catch (e) {
  failed = true;
  say(`FAIL: ${e.message}`);
  for (const a of [alice, bob]) { try { say(`${a.name} peerd.log tail:\n${readFileSync(join(a.home, "peerd.log"), "utf8").trimEnd().split("\n").slice(-25).join("\n")}`); } catch {} }
} finally {
  for (const a of [alice, bob]) { try { mesh(a, "stop"); } catch {} }
  try { mesh(alice, "status"); } catch {}
}
say(`log ${LOG}`);
process.exit(failed ? 1 : 0);
