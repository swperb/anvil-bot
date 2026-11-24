#!/bin/sh
# Runs on the NAS. Reads the bot token without echoing it and writes it to
# secrets/discord_token, readable only by its owner and the container's group.
set -eu
# This file is deployed to <root>/app/scripts/remote/; the token goes in <root>/secrets/.
dir="$(cd "$(dirname "$0")/../../../secrets" && pwd)"
umask 027
printf 'Paste the bot token (it will not be shown), then press Return: ' >&2
trap 'stty echo' EXIT INT TERM
stty -echo
IFS= read -r token || true
stty echo
printf '\n' >&2
case "$token" in
  "" ) echo "No token entered; nothing changed." >&2; exit 1 ;;
  *[[:space:]]* ) echo "That has spaces in it, so it is not a token; nothing changed." >&2; exit 1 ;;
esac
printf '%s' "$token" > "$dir/discord_token.tmp"
unset token
# The container runs as the "apps" group. Only root can hand a file to a group
# you are not in, so ask the TrueNAS middleware to do it.
midclt call --job=1 filesystem.chown "{\"path\":\"$dir/discord_token.tmp\",\"uid\":$(id -u),\"gid\":568}" >/dev/null 2>&1 || {
  rm -f "$dir/discord_token.tmp"
  echo "Could not give the token file to the apps group (midclt filesystem.chown failed); nothing changed." >&2
  exit 1
}
chmod 640 "$dir/discord_token.tmp"
mv "$dir/discord_token.tmp" "$dir/discord_token"
echo "Saved. Run 'scripts/nas.sh deploy' (first time) or 'scripts/nas.sh restart' to use it." >&2
