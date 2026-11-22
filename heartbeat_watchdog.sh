#!/bin/bash
# Mesh heartbeat watchdog: peerd can wedge internally (process alive, status.json
# heartbeat frozen). pm2/nohup only catch crashes, so restart on a stale heartbeat
# instead. Cron: every 5 min, e.g.
#   */5 * * * * /path/to/heartbeat_watchdog.sh >> /tmp/mesh_watchdog.log 2>&1
# One identity per run: set DECENT_PEER_HOME for an identity other than ~/.decent-peer.
HOME_DIR="${DECENT_PEER_HOME:-$HOME/.decent-peer}"
SKILL_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
AGE=$(DECENT_PEER_HOME="$HOME_DIR" python3 - <<'PY'
import json, datetime, os
p = os.path.join(os.environ["DECENT_PEER_HOME"], "status.json")
try:
    ts = json.load(open(p)).get("ts")
    t = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()))
except Exception:
    print(99999)
PY
)
[ "$AGE" -lt 600 ] && exit 0
echo "$(date) heartbeat stale ${AGE}s for $HOME_DIR — restarting peerd"

# cron's PATH has no nvm/homebrew, so a bare `pm2` or `node` is usually not found
# here. Look in the usual install dirs too (override: MESH_NODE / MESH_PM2).
find_bin() {
  local found c
  found=$(command -v "$1" 2>/dev/null) && { echo "$found"; return; }
  for c in "$HOME"/.nvm/versions/node/*/bin/"$1" /usr/local/bin/"$1" /opt/homebrew/bin/"$1"; do
    [ -x "$c" ] && found="$c"
  done
  echo "$found"
}
PM2="${MESH_PM2:-$(find_bin pm2)}"
NODE="${MESH_NODE:-$(find_bin node)}"
# pm2 is a node script: give it a PATH that can resolve `node`.
[ -n "$PM2" ] && export PATH="$(dirname "$PM2"):$PATH"

if [ -n "$PM2" ] && "$PM2" describe peerd >/dev/null 2>&1; then
  "$PM2" restart peerd >/dev/null 2>&1
else
  [ -z "$NODE" ] && { echo "$(date) node not found — cannot restart peerd (set MESH_NODE)"; exit 1; }
  # `mesh restart` stops only this identity's daemon (peerd.pid) and starts it detached.
  # peerd refuses to start a second copy on one identity, so a supervisor that already
  # respawned it wins and nothing runs twice.
  DECENT_PEER_HOME="$HOME_DIR" "$NODE" "$SKILL_DIR/mesh" restart
fi
