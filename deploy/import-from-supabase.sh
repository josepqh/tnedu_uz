#!/bin/sh
# Moves the live data from Supabase into this server's database (the tnedu.uz cut-over).
#
# Run it only while tnedu.uz does NOT point at this server yet: it replaces everything in the
# local database. Until the DNS switch it can be run again to pick up the latest data.
#
#   sh import-from-supabase.sh               dump Supabase, then restore that dump here
#   sh import-from-supabase.sh <name.dump>   restore a dump already in ./backups
#
# The Supabase connection string is read from /root/.supabase-url (chmod 600, one line): the
# DATABASE_URL used on Vercel. Port 6543 (transaction pooler) is switched to 5432 (session
# pooler), which pg_dump needs.
set -eu
cd "$(dirname "$0")"

URL_FILE=/root/.supabase-url
IMAGE=postgres:18.1-alpine
STAMP=$(date +%Y%m%d-%H%M%S)
SAFETY="pre-import-$STAMP.dump"
umask 077
mkdir -p backups
chmod 700 backups

trap 'status=$?; [ "$status" -eq 0 ] || echo "Import FAILED (exit $status). The app may be stopped. The previous data is in backups/$SAFETY; to put it back: sh $0 $SAFETY"' EXIT

if [ $# -ge 1 ]; then
  DUMP=$(basename "$1")
  [ -s "backups/$DUMP" ] || { echo "backups/$DUMP not found"; exit 1; }
  echo "1/5 Using backups/$DUMP"
else
  [ -s "$URL_FILE" ] || { echo "Put the Supabase connection string in $URL_FILE first (chmod 600)."; exit 1; }
  DUMP="supabase-import-$STAMP.dump"
  echo "1/5 Dumping the public schema from Supabase to backups/$DUMP ..."
  docker run --rm -e PGSSLMODE=require \
    -v "$URL_FILE:/run/supabase-url:ro" -v "$PWD/backups:/backups" "$IMAGE" sh -c '
      url=$(sed -e "s#?.*##" -e "s#:6543/#:5432/#" /run/supabase-url | head -n 1)
      pg_dump "$url" --schema=public --no-owner --no-privileges -Fc -f "/backups/$1.part"
      mv "/backups/$1.part" "/backups/$1"
    ' sh "$DUMP"
fi
ls -l "backups/$DUMP"

echo "2/5 Saving the current local database to backups/$SAFETY ..."
docker compose exec -T db-backup pg_dump -Fc -f "/backups/$SAFETY"

echo "3/5 Stopping the app ..."
docker compose stop app

echo "4/5 Replacing the local database ..."
docker compose exec -T db-backup psql -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public'
# The public schema already exists here, and Supabase's access policies name roles this
# database does not have (the app connects as the tables' owner and never needs them).
docker compose exec -T db-backup sh -c '
  pg_restore -l "/backups/$1" > /tmp/all.list
  grep -v -E " (SCHEMA - public|COMMENT - SCHEMA public|POLICY) " /tmp/all.list > /tmp/restore.list || true
  skipped=$(grep -c -E " (SCHEMA - public|COMMENT - SCHEMA public|POLICY) " /tmp/all.list || true)
  echo "   skipping $skipped schema/policy entries"
  pg_restore --no-owner --no-privileges --single-transaction -L /tmp/restore.list -d "$PGDATABASE" "/backups/$1"
' sh "$DUMP"

echo "5/5 Starting the app ..."
docker compose up -d --wait --wait-timeout 90 app

echo
echo "Migrations:"
docker compose exec -T db-backup psql -q -At -c 'SELECT version FROM np_schema_migrations ORDER BY 1'
echo
echo "Rows per table:"
docker compose exec -T db-backup psql -q -c "
  SELECT c.relname AS table_name,
         (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS row_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY 1"
echo "Import finished."
