// Profile tests: the CLI writes profile.json, the daemon side turns it into setUserInfo. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAvatar, punkImageUrl, readProfile, toPeerOptions, toUserInfo, validateProfile, watchProfile, writeProfile } from "../profile.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MESH = join(REPO, "mesh");
const tmp = () => mkdtempSync(join(tmpdir(), "mesh-profile-"));
const mesh = (home, ...args) => spawnSync(process.execPath, [MESH, ...args], { env: { ...process.env, DECENT_PEER_HOME: home, AGENT_NAME: "" }, encoding: "utf8" });

test("avatar parsing and the punk image url", () => {
  assert.equal(parseAvatar("2"), 2);
  assert.equal(parseAvatar("0"), 0);
  assert.equal(parseAvatar("9999"), 9999);
  assert.equal(parseAvatar("none"), null);
  assert.throws(() => parseAvatar("10000"));
  assert.throws(() => parseAvatar("-1"));
  assert.throws(() => parseAvatar("2.5"));
  assert.throws(() => parseAvatar("punk"));
  assert.equal(punkImageUrl(2), "https://www.larvalabs.com/cryptopunks/cryptopunk0002.png");
  assert.equal(punkImageUrl(7804), "https://www.larvalabs.com/cryptopunks/cryptopunk7804.png");
});

test("limits: name 63 bytes, description 127 bytes (Carrier UserInfo)", () => {
  assert.deepEqual(validateProfile({ name: "x".repeat(63), description: "y".repeat(127), avatar: 1 }), []);
  assert.equal(validateProfile({ name: "x".repeat(64) }).length, 1);
  assert.equal(validateProfile({ name: "é".repeat(32) }).length, 1); // 64 bytes
  assert.equal(validateProfile({ description: "y".repeat(128) }).length, 1);
  assert.equal(validateProfile({ avatar: 10000 }).length, 1);
});

test("toUserInfo / toPeerOptions: AGENT_NAME is the default name, removed fields are cleared", () => {
  assert.deepEqual(toUserInfo({}, "agent"), { name: "agent", description: "", punkId: null });
  assert.deepEqual(toUserInfo({ name: "Ops", description: "d", avatar: 5 }, "agent"), { name: "Ops", description: "d", punkId: 5 });
  assert.deepEqual(toPeerOptions({ name: "Ops", avatar: 0 }, "agent"), { nickname: "Ops", statusMessage: "", punkId: 0 });
  assert.deepEqual(toPeerOptions({}, "agent"), { nickname: "agent", statusMessage: "" });
});

test("mesh profile: set, merge, print, clear avatar, reject bad input", () => {
  const home = tmp();
  try {
    let r = mesh(home, "profile");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /name\s+\(unset\)/);

    r = mesh(home, "profile", "--name", "Research Bot", "--avatar", "2");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readProfile(home), { name: "Research Bot", avatar: 2 });
    assert.match(r.stdout, /applied when the daemon starts/);

    r = mesh(home, "profile", "--description=Answers questions about papers");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readProfile(home), { name: "Research Bot", description: "Answers questions about papers", avatar: 2 });

    r = mesh(home, "profile");
    assert.match(r.stdout, /Research Bot/);
    assert.match(r.stdout, /cryptopunk0002\.png/);

    r = mesh(home, "profile", "--avatar", "none");
    assert.equal(r.status, 0);
    assert.equal(readProfile(home).avatar, undefined);

    for (const bad of [["--avatar", "10000"], ["--name", "x".repeat(64)], ["--nickname", "a"], ["stray"]]) {
      r = mesh(home, "profile", ...bad);
      assert.notEqual(r.status, 0, `accepted ${bad.join(" ")}`);
    }
    assert.equal(readProfile(home).name, "Research Bot", "a rejected change must not touch the file");

    r = mesh(home, "profile", "--clear");
    assert.equal(r.status, 0);
    assert.deepEqual(readProfile(home), {});
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("watchProfile applies a changed profile.json live and skips an invalid one", async () => {
  const home = tmp();
  try {
    writeProfile(home, { name: "A" });
    const calls = [];
    const peer = { setUserInfo: (u) => calls.push(u) };
    const logs = [];
    const w = watchProfile({ home, peer, defaultName: "agent", log: (m) => logs.push(m), intervalMs: 60_000 });
    try {
      assert.equal(w.check(), false, "unchanged file: nothing to apply");
      await new Promise((r) => setTimeout(r, 15)); // distinct mtime
      writeProfile(home, { name: "B", description: "desc", avatar: 3 });
      assert.equal(w.check(), true);
      assert.deepEqual(calls.at(-1), { name: "B", description: "desc", punkId: 3 });

      await new Promise((r) => setTimeout(r, 15));
      writeProfile(home, { name: "B" });
      assert.equal(w.check(), true);
      assert.deepEqual(calls.at(-1), { name: "B", description: "", punkId: null }, "removed fields are cleared");

      await new Promise((r) => setTimeout(r, 15));
      writeFileSync(join(home, "profile.json"), JSON.stringify({ name: "x".repeat(80) }));
      assert.equal(w.check(), false);
      assert.equal(calls.length, 2);
      assert.match(logs.at(-1), /not applied/);

      await new Promise((r) => setTimeout(r, 15));
      writeFileSync(join(home, "profile.json"), "{not json");
      assert.equal(w.check(), false);
      assert.equal(calls.length, 2);
    } finally { w.stop(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("no hard-coded home paths in the shipped files", () => {
  const files = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).files;
  for (const f of files) {
    const text = readFileSync(join(REPO, f), "utf8");
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|\.claude\/skills\/agent-mesh"?\s*&&|blockchain\/eth/, `${f} hard-codes a path`);
  }
  execFileSync(process.execPath, ["--check", MESH]);
});
