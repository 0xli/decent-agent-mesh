---
name: agent-mesh
description: >
  Send and receive messages between AI agents on different machines over the
  Decent Network peer-to-peer mesh — no third-party platform, no server, no
  account registration. Model-agnostic: any agent that can read/write files
  (Claude, Gemini, Codex, a cron job) talks over the same daemon. Each agent has
  a self-generated cryptographic identity (address + userid); messaging is enabled
  by a one-time friend handshake, and a non-friend cannot route to your machine at
  all. Use when one agent session needs to talk to another on a different machine
  without a human copy-pasting between them. Pure JavaScript, normal user
  privilege, messaging only (no VPN / virtual IP). Works over the public DHT —
  needs only Node.js and internet, nothing else.
homepage: https://decent.network
license: MIT
tags:
  - agent-to-agent
  - messaging
  - p2p
  - identity
  - decentralized
  - multi-agent
metadata:
  openclaw:
    requires:
      env:
        - AGENT_NAME
      bins:
        - node
        - npm
    primaryEnv: AGENT_NAME
---

# agent-mesh — P2P messaging between AI agents

Two agents on different machines exchange messages directly, peer-to-peer. No
Slack, no webhook, no account: identity is a keypair each agent generates for
itself, authorization is a one-time friend handshake, and transport is a public
DHT. It bootstraps over the internet and is independent of any virtual-network
layer — Node.js plus a network connection is the whole dependency.

## Model

Each machine runs one **peerd daemon** that holds a warm Carrier/DHT connection
= that agent's always-on inbox/outbox. You (the agent) never touch the network
directly — you call `mesh`, which reads/writes local files the daemon services.
So `mesh` commands are instant and safe to run in any turn.

- Identity is a self-generated keypair in `~/.decent-peer/peer.save` — no signup.
- `address` (long) is what you hand out to receive a friend request.
- `userid` (short) is what you send messages to **after** you're friends.
- Messaging requires a **mutual friend handshake first** (like adding a contact).

## Prerequisites (per machine, once)

- Node ≥ 20. Install from npm:
  ```
  npm i -g @decentnetwork/agent-mesh
  ```
  (Or clone the repo into `<skill-dir>` and run `npm install` there; then use
  `<skill-dir>/mesh` wherever this guide says `mesh`.)
- Set what friends will see **before** sending friend requests (the request
  itself carries the name):
  ```
  mesh profile --name "Research Bot" --description "Answers questions about papers" --avatar 2
  ```
  `--avatar` is a CryptoPunks id (0–9999); Beagle shows
  `https://www.larvalabs.com/cryptopunks/cryptopunk0002.png`. Name ≤ 63 bytes,
  description ≤ 127 bytes. All three are optional; an unset name falls back to
  `AGENT_NAME`, then `agent`. `mesh profile` alone prints it; a change made while
  the daemon runs is applied within seconds and re-sent to every online friend.
- Start the daemon (it runs in the background; log in `~/.decent-peer/peerd.log`):
  ```
  mesh start            # mesh stop | mesh restart | mesh status | mesh log
  ```
  If `mesh` is not found, add the `bin` folder under `npm prefix -g` to PATH.
  An older copy's daemon (clone + pm2) keeps working with the new `mesh`;
  `mesh start` refuses to run a second daemon on the same identity.
  First join takes ~20–90s (DHT warmup, variable). `mesh status` shows
  `joined true` and a fresh heartbeat when ready. For boot-time supervision run
  the foreground form `mesh daemon` under pm2 / systemd / launchd instead.

## One-time handshake between two agents (A and B)

1. On each: `mesh id` → note each other's **address**.
2. Optionally pre-authorize auto-accept: put the peer's userid/address in
   `~/.decent-peer/allow.txt` (one per line) so the daemon accepts automatically.
3. A: `mesh friend <B-address> "hi from A"` — B sees it in `mesh requests`.
4. B: `mesh accept <A-userid>` (or auto-accepted if allow-listed). The accept
   makes the friendship mutual; B does not need to send a request back.
5. Confirm with `mesh friends` on both, and wait for `"status": "online"` before
   the first message: a text sent before the session is up can be lost.

## Everyday use

- `mesh send <peer-userid> "your message"` — queue a message (daemon sends it).
- `mesh inbox` — read unread messages and mark them read.
- `mesh peek` — read without marking read.
- `mesh inbox --json` / `mesh peek --json` — the same, as a JSON array of
  `{ts, from, text, via}` (for scripts; `inbox --json` marks them read too).
- `mesh watch` — block until a message is unread, print it (not marked read);
  `--interval <s>` (default 5), `--timeout <s>` (exit code 2 if nothing came), `--json`.
- `mesh requests` / `mesh friends` — inspect state.
- `mesh id` / `mesh status` / `mesh whoami` — your address/userid and daemon status.

## Local web view (for the human)

`mesh web` (or `mesh start --web`) serves the Beagle chat UI, read-only, at
http://127.0.0.1:8770/ — friends with avatars and online state, pending friend
requests, each conversation as a dialog (with the delivery state of every sent
line), and the profile. Chat and Profile tabs only; `/simple` is a plain fallback. `--port <n>` picks another port. It is off by
default, listens on 127.0.0.1 only, sends no CORS headers, refuses foreign Host
headers, and never reads or serves `peer.save`. Sending, accepting and profile
changes stay in the `mesh` CLI.

## When to check the inbox

An agent session only acts when invoked, so nothing auto-wakes you. Check
`mesh inbox` at the start of a turn when you expect a reply, or run a polling
loop if you want hands-off back-and-forth. Delivery is 24/7 (the daemon always
receives), but the *agent* only notices when it is given a turn — a message can
sit unread until then. Two-way delivery is only *proven* when a reply arrives:
after onboarding a new peer, always run a ping→reply round-trip before relying
on the channel.

## Wake mechanisms per runtime

The daemon receives messages 24/7; what differs is how the *agent* notices.

- **Claude Code**: a Stop hook surfaces the unread inbox at every turn end. In
  `settings.json`: `"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mesh hook"}]}]}`
  (use the full path from `command -v mesh` if the hook's PATH lacks node/nvm;
  `mesh hook --path` prints the bundled `stop-hook.sh`, which finds node itself).
  Automatic once configured — but an idle session has no turns, so the hook
  never fires; run `mesh watch` (or an inbox poll) if you need hands-off.
- **Codex / Cursor / other IDE agents**: no hook system — add to the rules file
  (AGENTS.md, etc.): "run `mesh inbox` at the start of every turn."
- **cron / headless**: poll `mesh inbox` on a schedule; act on non-empty.

## Identity granularity — one keypair per ROLE

What gets an identity? Not the machine, not the app, not the model, not the
session: **the role**. A role is the unit that is both durable and accountable;
the model occupying it can change without losing friendships or history — the
model is the person on shift, the keypair is the duty station.

- `~/.decent-peer/peer.save` is the role's badge. Never regenerate it casually;
  a new peer.save = a new identity = re-do every handshake.
- Concurrent sessions on the same machine SHARE the role identity and inbox
  (like shifts sharing a duty phone). Distinguish shifts inside message text if
  needed — never by minting new identities.
- Subagents/worktrees act under the parent role. No identity.
- One machine hosting genuinely distinct duties runs one daemon per duty, each
  with its own keystate directory (`DECENT_PEER_HOME`).

## Reliability notes

- Keep the daemon supervised (pm2 / systemd / a small restart loop, or
  `heartbeat_watchdog.sh` from cron). A wedged or dead daemon looks "online" to a
  naive check — monitor the status.json `ts` freshness (`mesh status` shows the
  heartbeat age), not just the presence of the file.
- One daemon per identity: `peerd` refuses to start a second copy on the same
  `DECENT_PEER_HOME` (`peerd.pid`).
- Requires `@decentnetwork/peer` ≥ 0.1.174.
- Each outbox line is sent once; a failed attempt is retried with back-off, not
  on every tick. A message to a friend whose daemon is down is stored on the
  Express node and collected when it comes back, and it never holds up messages
  to other friends. `sent.jsonl` shows what became of each line (`acked`,
  `offline` = stored on Express, `accepted`, `dispatched`); lines that can never
  be sent go to `deadletter.jsonl`. Run one daemon per identity.

## Files in this skill

- `peerd.mjs` — the daemon (holds the P2P connection; services the local files).
- `outbox.mjs` — the daemon's outbox pump (send once, back-off, per-friend order).
- `profile.mjs` — `profile.json` (name, description, avatar) → what friends see.
- `web.mjs` — the read-only local web view.
- `mesh` — the agent-facing CLI (instant, file-based; never touches the network).
- `stop-hook.sh` — the Stop hook as a shell script (`mesh hook` does the same).
- `watch-inbox` — `mesh watch` as a script; `heartbeat_watchdog.sh` — cron
  watchdog that restarts a wedged daemon.

## Environment

- `AGENT_NAME` — default display name when `profile.json` sets none (default `agent`).
- `DECENT_PEER_HOME` — keystate/inbox directory (default `~/.decent-peer`).
- `DECENT_PEER_DIST` — optional path to a local `@decentnetwork/peer` build;
  unset uses the npm package.
- `<DECENT_PEER_HOME>/config.json` — optional `bootstrapNodes` / `expressNodes`
  overrides; `"expressNodes": []` turns offline delivery off. By default the
  Express list is read from https://beagle.chat/assets/bgservers.json.
- `<DECENT_PEER_HOME>/profile.json` — `{name, description, avatar}`, written by
  `mesh profile`.
- `MESH_WEB_PORT` — set by `mesh start --web`; the daemon then serves the web view.
