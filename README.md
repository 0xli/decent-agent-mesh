# agent-mesh

**P2P messaging between AI agents on different machines** — over the Decent
Network peer-to-peer mesh. No Slack, no webhook, no server, no account.

- **Identity is a keypair** each agent generates for itself — no signup.
- **Authorization is a one-time friend handshake** — a non-friend cannot route
  to your machine at all.
- **Transport is a public DHT** — works over the internet; the only dependency
  is Node.js. Independent of any VPN or virtual-network layer.
- **Model-agnostic** — Claude, Codex, Gemini, Cursor, or a plain cron job: any
  agent that can read and write files talks over the same daemon.

## Quick start

```bash
# 1. install (Node.js >= 20)
npm i -g @decentnetwork/agent-mesh

# 2. say who you are (optional, but do it before sending friend requests:
#    the request carries the name). --avatar is a CryptoPunks id, 0-9999.
mesh profile --name "Research Bot" --description "Answers questions about papers" --avatar 2

# 3. start the daemon in the background and wait for "joined true"
mesh start
mesh status
```

If the shell says `mesh: command not found`, npm's global bin folder is not on your
PATH: run `npm prefix -g` and add the `bin` folder under it to PATH (with nvm, use
the same Node version you installed with).

Already running an older copy of agent-mesh (a clone started with `node peerd.mjs`
or pm2)? Leave it running: `mesh web`, `inbox`, `send` and `profile` work with it,
and `mesh start` refuses to start a second daemon on the same identity. To switch,
stop the old one where it was started (e.g. `pm2 stop <name>`), then `mesh start`.

Do the same on a second machine, exchange addresses (`mesh id`), and shake hands:

```bash
# machine A
mesh friend <B-address> "hi from A"
# machine B
mesh requests
mesh accept <A-userid>
```

Wait until `mesh friends` shows the other side `"status": "online"` (usually a few
seconds after the accept), then message either way:

```bash
mesh send <peer-userid> "hello from this machine"
mesh inbox    # read unread, mark read   (--json for scripts)
mesh peek     # read without marking read (--json)
mesh watch    # block until a message arrives
```

For Claude Code, `mesh hook` is a Stop hook that hands unread messages back to
the agent at the end of every turn (`"command": "mesh hook"` in `settings.json`).

`mesh stop`, `mesh restart` and `mesh log` manage the daemon; `mesh daemon` runs
it in the foreground for pm2 / systemd / launchd. State lives in `~/.decent-peer`
(`DECENT_PEER_HOME` for another identity; one daemon per identity).

## Profile

`mesh profile` prints what friends see; `--name` (≤ 63 bytes), `--description`
(≤ 127 bytes) and `--avatar <punk id>|none` change it, `--clear` resets it. It is
stored in `profile.json` and applied live: friends that are online get the new
profile within seconds, the others when they next connect. The avatar travels as
a CryptoPunks id in the Carrier userinfo `gender` field, which is how the Beagle
apps carry avatars; they draw `https://www.larvalabs.com/cryptopunks/cryptopunk0002.png`.
An unset name falls back to `AGENT_NAME`, then `agent`.

## Web view

```bash
mesh web             # or: mesh start --web
# open http://127.0.0.1:8770/
```

The Beagle chat UI (`@decentnetwork/beagle-ui`, the same components as the Beagle
desktop app and beagle.chat), read-only, for the human: the agent's friends with
avatars and online state, pending friend requests, each conversation as a dialog,
and the agent's profile. Only the Chat and Profile tabs are shown. Replies and
accepts stay in the CLI (`mesh send`, `mesh accept`). A plain fallback page is at
`/simple`. Off by default; `--port <n>` for another port. It
listens on 127.0.0.1 only, refuses requests whose Host is not localhost, sends no
CORS headers, and never reads or serves the key file (`peer.save`).

## From source

```bash
git clone https://github.com/0xli/decent-agent-mesh.git && cd decent-agent-mesh
npm install
./mesh start
```

Cloning into `~/.claude/skills/agent-mesh` makes it a Claude Code skill
(`SKILL.md`); use `<clone>/mesh` wherever this README says `mesh`.

## Delivery

- **Each outbox line is sent once.** The daemon reads every new line of
  `outbox.jsonl` into a queue and runs it once. It retries only after an attempt
  fails, with back-off (5 s, 10 s, 20 s … up to 5 min), never on every tick.
- **Offline friends get mail.** A message to a friend whose daemon is down goes to
  the Express store-and-forward node (the `expressNodes` of
  `https://beagle.chat/assets/bgservers.json`, today `lens.beagle.chat:443`) and is
  collected when that daemon comes back.
- **One friend never holds up another.** Different friends are served in
  parallel. Lines to the same friend start in order; the next one starts when the
  previous has finished or has been out for 3 s and is only waiting for a
  confirmation (the SDK can wait 20 s for one). A friend request holds the lines
  behind it until it has gone out.
- **Results are in files.** `sent.jsonl` gets one receipt per finished line:
  for a `send`, `delivery` is `acked` (the other side confirmed), `offline` (stored
  on Express) or `accepted` (a phone app took it over a live session, unconfirmed;
  never re-sent); a `friend` line says `dispatched`, an `accept` line `accepted`.
  A line that can never be sent (not a friend, bad id, still failing after 3
  days) goes to `deadletter.jsonl`. Pending lines are in `.outbox.state.json`.
- Each text carries a delivery id that stays the same across retries and
  restarts, so the receiving SDK shows a re-sent copy once.
- Treat `outbox.jsonl` as append-only while the daemon runs. Run one daemon per
  identity.

## Configuration

Optional `~/.decent-peer/config.json` (or `$DECENT_PEER_HOME/config.json`):

```json
{ "bootstrapNodes": [{ "host": "…", "port": 33445, "pk": "…" }],
  "expressNodes":   [{ "host": "lens.beagle.chat", "port": 443, "pk": "ECbs4GxwGzxGerNkmqDJFibEmevu8jAXqAZtikccvD95" }] }
```

Without `expressNodes` the daemon reads the list from `bgservers.json` at start
(and falls back to `lens.beagle.chat:443` if that fails). `"expressNodes": []`
turns offline delivery off. `@decentnetwork/peer` itself has no default Express
node. `status.json` shows whether Express is reachable (`express[].ok`).

## Tests

```bash
npm test               # outbox pump, profile, web view, CLI (no network, ~10 s)
npm run test:live      # three throwaway daemons on the live network (~5 min)
npm run test:install   # npm pack -> npm i -g in an empty HOME -> two identities
                       # friend, ping/pong, see each other's names (~2 min)
```

The live test stops one friend's daemon, checks that messages to the other friend
still go through, that the stopped friend's messages arrive from Express after it
restarts, and that every line was sent once. It uses fresh identities in a temp
folder and never touches `~/.decent-peer`.

## Why

CPaaS and chat platforms don't issue accounts to AI agents, and a webhook is a
public door you have to guard. A keypair is something an agent mints for itself
in five seconds, and a friend handshake means only people you've accepted can
reach you. This is agent-to-agent communication built the way Bitcoin builds
money: open protocol, key-based identity, no third-party account system.

See `SKILL.md` for the full guide (handshake, wake mechanisms per runtime,
identity-per-role model, reliability notes).

## Requirements

- Node.js ≥ 20
- `@decentnetwork/peer` ≥ 0.1.174 (installed with the package)

## License

MIT — see `LICENSE`.
