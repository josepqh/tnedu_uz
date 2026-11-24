#!/bin/sh
# Saves one secret in .env without showing it on screen, then restarts the app.
#
#   ssh -t root@<server> sh /opt/tnedu/deploy/set-secret.sh RESEND_API_KEY
set -eu
cd "$(dirname "$0")"

name=${1:?usage: sh set-secret.sh NAME}
printf %s "$name" | grep -q '^[A-Z][A-Z0-9_]*$' || { echo "Bad name: $name"; exit 1; }

printf 'Paste %s and press Enter (the input stays hidden): ' "$name"
stty -echo
trap 'stty echo' EXIT INT TERM
IFS= read -r value
stty echo
echo

value=$(printf %s "$value" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
[ -n "$value" ] || { echo "Empty value: nothing changed."; exit 1; }
# Compose reads .env itself: quotes, spaces or $ would be changed on the way.
printf %s "$value" | grep -q '^[A-Za-z0-9_.@+:/=-]*$' || { echo "The value has unexpected characters: nothing changed."; exit 1; }

umask 077
tmp=$(mktemp .env.XXXXXX)
grep -v "^$name=" .env > "$tmp" || true
printf '%s=%s\n' "$name" "$value" >> "$tmp"
mv "$tmp" .env
echo "$name saved. Restarting the app ..."
docker compose up -d --wait --wait-timeout 90 app

if [ "$name" = RESEND_API_KEY ]; then
  # Asks Resend about the key without sending any mail.
  docker compose exec -T app node -e "
    fetch('https://api.resend.com/domains', { headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY } })
      .then(async (r) => {
        const text = await r.text();
        if (r.ok || text.includes('restricted_api_key')) console.log('Resend: the key works.');
        else console.log('Resend refused the key:', r.status, text.slice(0, 120));
      })
      .catch((e) => console.log('Could not reach Resend:', e.message));"
fi
