#!/usr/bin/env bash
# Run Anvil on a TrueNAS SCALE box as a custom Docker app.
#
#   scripts/nas.sh setup      create the dataset and folders (once)
#   scripts/nas.sh token [github]  store or replace the Discord (or GitHub) token; never echoed
#   scripts/nas.sh deploy     copy the code over and (re)start the app
#   scripts/nas.sh restart | stop | start | status
#   scripts/nas.sh logs [N]   the last N lines of Anvil's log (default 50)
#
# Settings come from the environment or ~/.config/anvil-bot/nas.env:
#   NAS_HOST      SSH host name of the TrueNAS box (required)
#   NAS_USER      SSH user with middleware access (default truenas_admin)
#   NAS_DATASET   dataset to keep Anvil in (default <first pool>/anvil-bot)
#   GUILD_ID      the Discord server Anvil serves (required for deploy)
#   APP_NAME      TrueNAS app name (default anvil-bot)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
conf="${ANVIL_NAS_ENV:-$HOME/.config/anvil-bot/nas.env}"
# shellcheck disable=SC1090
[ -f "$conf" ] && . "$conf"
: "${NAS_HOST:?Set NAS_HOST (in $conf or the environment) to the SSH host name of the TrueNAS box.}"
NAS_USER="${NAS_USER:-truenas_admin}"
APP_NAME="${APP_NAME:-anvil-bot}"
# node:24-alpine, pinned by digest so a changed upstream image is never pulled silently.
# To update: look up the new digest for node:24-alpine and change it here.
IMAGE="${IMAGE:-node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5}"
APPS_UID=568   # TrueNAS's unprivileged "apps" user; the container runs as it.

ssh_nas() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$NAS_USER@$NAS_HOST" "$@"; }
# Quote one argument for the remote shell (TrueNAS logs in to zsh, which re-parses it).
q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
quoted() { local a out=""; for a in "$@"; do out+="$(q "$a") "; done; printf '%s' "$out"; }
midclt() { ssh_nas "midclt call $(quoted "$@")"; }
job() { ssh_nas "midclt call --job=1 $(quoted "$@")" >/dev/null; }

dataset() {
  if [ -n "${NAS_DATASET:-}" ]; then echo "$NAS_DATASET"; return; fi
  local pool
  pool="$(midclt pool.query '[]' '{"select":["name"]}' | python3 -c 'import json,sys; p=json.load(sys.stdin); print(p[0]["name"] if p else "")')"
  [ -n "$pool" ] || { echo "No storage pool found on $NAS_HOST; set NAS_DATASET." >&2; exit 1; }
  echo "$pool/anvil-bot"
}
root() { echo "/mnt/$(dataset)"; }

app_exists() {
  [ "$(midclt app.query "[[\"name\",\"=\",\"$APP_NAME\"]]" '{"select":["name"]}')" != "[]" ]
}

cmd_setup() {
  local ds r uid
  ds="$(dataset)"; r="/mnt/$ds"
  if [ "$(midclt pool.dataset.query "[[\"id\",\"=\",\"$ds\"]]" '{"select":["id"]}')" = "[]" ]; then
    echo "Creating dataset $ds"
    midclt pool.dataset.create "{\"name\":\"$ds\"}" >/dev/null
  fi
  uid="$(ssh_nas id -u)"
  # Dataset root and app/: owned by the SSH user, readable by the container.
  job filesystem.setperm "{\"path\":\"$r\",\"uid\":$uid,\"gid\":$uid,\"mode\":\"755\",\"options\":{\"stripacl\":true}}"
  ssh_nas "mkdir -p $(q "$r/app") $(q "$r/data") $(q "$r/secrets")"
  # data/: the container (group apps) writes there; files it creates are
  # world-readable inside a folder only the SSH user and apps can enter, so the
  # SSH user can read the log. secrets/: only the SSH user writes; the token file
  # gets group apps and mode 640 (see scripts/remote/write-token.sh).
  job filesystem.setperm "{\"path\":\"$r/data\",\"uid\":$uid,\"gid\":$APPS_UID,\"mode\":\"770\",\"options\":{\"stripacl\":true}}"
  job filesystem.setperm "{\"path\":\"$r/secrets\",\"uid\":$uid,\"gid\":$APPS_UID,\"mode\":\"750\",\"options\":{\"stripacl\":true}}"
  sync_code
  ssh_nas "ls -ld $(q "$r") $(q "$r/app") $(q "$r/data") $(q "$r/secrets")"
  echo "Set up $r. Next: scripts/nas.sh token"
}

sync_code() {
  local stage r
  r="$(root)"
  stage="$(mktemp -d)"
  cp -R "$here/src" "$here/package.json" "$here/package-lock.json" "$stage/"
  mkdir -p "$stage/scripts/remote" && cp "$here/scripts/remote/write-token.sh" "$stage/scripts/remote/"
  (cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
  chmod -R u=rwX,go=rX "$stage"
  rsync -rlpt --delete "$stage/" "$NAS_USER@$NAS_HOST:$r/app/"
  rm -rf "$stage"
  ssh_nas "chmod 755 $(q "$r/app") $(q "$r/app/scripts/remote/write-token.sh")"
}

cmd_token() {
  local r
  r="$(root)"
  local name=discord_token
  [ "${1:-}" = github ] && name=github_token
  ssh -t "$NAS_USER@$NAS_HOST" "sh $(q "$r/app/scripts/remote/write-token.sh") $name"
}

render_compose() {
  local r
  r="$(root)"
  sed -e "s|@ROOT@|$r|g" -e "s|@GUILD_ID@|$GUILD_ID|g" -e "s|@IMAGE@|$IMAGE|g" "$here/deploy/compose.yaml"
}

cmd_deploy() {
  : "${GUILD_ID:?Set GUILD_ID (in $conf or the environment) to the ID of the Discord server.}"
  local r payload
  r="$(root)"
  ssh_nas "test -s $(q "$r/secrets/discord_token")" || { echo "No token on the NAS yet. Run: scripts/nas.sh token" >&2; exit 1; }
  sync_code
  payload="$(render_compose | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  local sum
  sum="$(render_compose | shasum -a 256 | cut -d' ' -f1)"
  if app_exists; then
    # app.update restarts the app itself; only redeploy when the compose file is unchanged.
    if [ "$(ssh_nas "cat $(q "$r/compose.sha256") 2>/dev/null" || true)" != "$sum" ]; then
      echo "Updating $APP_NAME"
      job app.update "$APP_NAME" "{\"custom_compose_config_string\":$payload}"
    else
      echo "Restarting $APP_NAME with the new code"
      job app.redeploy "$APP_NAME"
    fi
  else
    echo "Creating $APP_NAME"
    job app.create "{\"app_name\":\"$APP_NAME\",\"custom_app\":true,\"custom_compose_config_string\":$payload}"
  fi
  ssh_nas "printf '%s' $(q "$sum") > $(q "$r/compose.sha256")"
  cmd_status
}

cmd_status() {
  midclt app.query "[[\"name\",\"=\",\"$APP_NAME\"]]" '{"select":["name","state"]}'
  echo
}

case "${1:-}" in
  setup) cmd_setup ;;
  token) cmd_token "${2:-}" ;;
  deploy) cmd_deploy ;;
  restart) job app.redeploy "$APP_NAME"; cmd_status ;;
  stop) job app.stop "$APP_NAME"; cmd_status ;;
  start) job app.start "$APP_NAME"; cmd_status ;;
  status) cmd_status ;;
  logs) ssh_nas "tail -n ${2:-50} $(q "$(root)/data/anvil.log")" ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
