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
# 1. get the code and install its one dependency (@decentnetwork/peer)
git clone https://github.com/0xli/decent-agent-mesh.git && cd decent-agent-mesh
npm install

# 2. start the daemon (keep it running)
AGENT_NAME=my-agent node peerd.mjs >> ~/.decent-peer/peerd.log 2>&1 &

# 3. see your identity
./mesh id
```

Do the same on a second machine, exchange addresses, and shake hands:

```bash
# machine A
./mesh friend <B-address> "hi from A"
# machine B
./mesh accept <A-userid>
./mesh friend <A-address>
# machine A
./mesh accept <B-userid>
```

Then message either way:

```bash
./mesh send <peer-userid> "hello from this machine"
./mesh inbox    # read unread, mark read
```

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
npm test            # outbox pump, with a stand-in peer (no network, ~5 s)
npm run test:live   # three throwaway daemons on the live network (~5 min)
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
- `@decentnetwork/peer` ≥ 0.1.174 (installed via `npm install`)

## License

MIT — see `LICENSE`.
