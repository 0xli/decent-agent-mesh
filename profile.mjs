// profile.mjs — what friends see: display name, description, avatar.
//
// <DECENT_PEER_HOME>/profile.json = {"name": "...", "description": "...", "avatar": 2}
//   name         display name (Carrier nickname / userinfo name), at most 63 bytes.
//                Unset falls back to $AGENT_NAME, then "agent".
//   description  status line under the name, at most 127 bytes.
//   avatar       a CryptoPunks id 0..9999. Beagle carries it in the Carrier userinfo
//                `gender` field and draws https://cryptopunks.app/cryptopunks/cryptopunkNNNN.png.
//
// `mesh profile` writes the file; the daemon applies it at start and again whenever the
// file changes (peer.setUserInfo re-sends the profile to every friend that is online).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LIMITS = { name: 63, description: 127, avatarMax: 9999 };

export const punkImageUrl = (id) => `https://cryptopunks.app/cryptopunks/cryptopunk${String(id).padStart(4, "0")}.png`;

/** Parse a user-supplied avatar value. Returns an integer id, null for "none", or throws. */
export function parseAvatar(v) {
  const s = String(v).trim().toLowerCase();
  if (s === "none" || s === "" || s === "off") return null;
  if (!/^\d+$/.test(s)) throw new Error(`avatar must be a CryptoPunks id 0..${LIMITS.avatarMax} (or "none"), got "${v}"`);
  const n = Number(s);
  if (n > LIMITS.avatarMax) throw new Error(`avatar must be a CryptoPunks id 0..${LIMITS.avatarMax}, got ${n}`);
  return n;
}

/** Check a profile object; returns a list of problems (empty = valid). */
export function validateProfile(p) {
  const errs = [];
  if (p.name !== undefined) {
    if (typeof p.name !== "string") errs.push("name must be text");
    else if (Buffer.byteLength(p.name) > LIMITS.name) errs.push(`name is ${Buffer.byteLength(p.name)} bytes; the limit is ${LIMITS.name}`);
  }
  if (p.description !== undefined) {
    if (typeof p.description !== "string") errs.push("description must be text");
    else if (Buffer.byteLength(p.description) > LIMITS.description) errs.push(`description is ${Buffer.byteLength(p.description)} bytes; the limit is ${LIMITS.description}`);
  }
  if (p.avatar !== undefined && p.avatar !== null) {
    if (!Number.isInteger(p.avatar) || p.avatar < 0 || p.avatar > LIMITS.avatarMax) errs.push(`avatar must be a CryptoPunks id 0..${LIMITS.avatarMax}`);
  }
  return errs;
}

export const profilePath = (home) => join(home, "profile.json");

/** Read profile.json; {} when absent. Throws on unreadable JSON. */
export function readProfile(home) {
  const f = profilePath(home);
  if (!existsSync(f)) return {};
  const p = JSON.parse(readFileSync(f, "utf8"));
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("profile.json is not an object");
  return p;
}

/** Write profile.json atomically (keys with undefined/null values are dropped). */
export function writeProfile(home, p) {
  const clean = {};
  for (const k of ["name", "description", "avatar"]) if (p[k] !== undefined && p[k] !== null && p[k] !== "") clean[k] = p[k];
  const errs = validateProfile(clean);
  if (errs.length) throw new Error(errs.join("; "));
  const f = profilePath(home);
  writeFileSync(`${f}.tmp`, JSON.stringify(clean, null, 2) + "\n");
  renameSync(`${f}.tmp`, f);
  return clean;
}

/**
 * profile.json (+ AGENT_NAME default) -> the argument for peer.setUserInfo.
 * Every field is explicit, so a field removed from the file is cleared on the wire
 * (an absent avatar is sent as null = "no avatar").
 */
export function toUserInfo(p, defaultName) {
  return {
    name: p.name || defaultName || "",
    description: p.description || "",
    punkId: Number.isInteger(p.avatar) ? p.avatar : null,
  };
}

/** Options for Peer.create, so the very first friend request already carries the profile. */
export function toPeerOptions(p, defaultName) {
  const u = toUserInfo(p, defaultName);
  const o = { statusMessage: u.description };
  if (u.name) o.nickname = u.name;
  if (u.punkId !== null) o.punkId = u.punkId;
  return o;
}

/**
 * Re-apply profile.json whenever it changes. Polls the file's mtime/size (cheap; works on
 * every filesystem, unlike fs.watch). Returns { stop, check }.
 */
export function watchProfile({ home, peer, defaultName, log = () => {}, intervalMs = 2000, onApply = () => {} }) {
  const f = profilePath(home);
  const sig = () => { try { const s = statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
  let last = sig();
  function check() {
    const now = sig();
    if (now === last) return false;
    last = now;
    let p;
    try { p = readProfile(home); } catch (e) { log(`PROFILE not applied: ${e.message}`); return false; }
    const errs = validateProfile(p);
    if (errs.length) { log(`PROFILE not applied: ${errs.join("; ")}`); return false; }
    const info = toUserInfo(p, defaultName);
    try { peer.setUserInfo(info); } catch (e) { log(`PROFILE setUserInfo failed: ${e.message}`); return false; }
    log(`PROFILE applied name="${info.name}" description="${info.description}" avatar=${info.punkId ?? "none"}`);
    onApply(info);
    return true;
  }
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), check };
}
