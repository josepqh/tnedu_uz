#!/bin/sh
# Runs in the db-backup container: a compressed dump every night at 03:30 (server time),
# keeping the newest 14.
set -u
# Dumps hold user data (emails, password hashes): readable by root only.
umask 077
KEEP=14

while true; do
  now=$(date +%s)
  next=$(date -d "$(date +%Y-%m-%d) 03:30" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))

  file="/backups/tnedu-$(date +%Y%m%d-%H%M).dump"
  if pg_dump -Fc -f "$file.part" && mv "$file.part" "$file"; then
    echo "backup ok: $file"
  else
    echo "backup FAILED"
    rm -f -- "$file.part"
  fi

  ls -1t /backups/tnedu-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f -- "$old"
  done
done
