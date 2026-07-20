#!/bin/bash
# SEC-D2 — WAL-safe, encrypted, off-host DB backup to Google Drive.
#
# Runs AS the `gorifi` user (the rclone remote `gdrive` and the age keys live
# under gorifi). Invoked from deploy.sh (production) before each deploy and from
# a daily cron. Usage: backup-db.sh [label]   (label e.g. deploy|cron|manual)
#
# Restore: rclone copy gdrive:db-backups/<file>.age . && \
#          age -d -i /var/www/gorifi/secrets/backup-age-key.txt <file>.age > database.sqlite
set -euo pipefail

DB="${DB_PATH:-/var/www/gorifi/backend/src/db/database.sqlite}"
SECRETS="/var/www/gorifi/secrets"
PUBFILE="$SECRETS/backup-age.pub"
REMOTE="gdrive:db-backups"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
LABEL="${1:-manual}"

for bin in sqlite3 age rclone; do
  command -v "$bin" >/dev/null || { echo "backup: missing dependency '$bin'" >&2; exit 1; }
done
[ -f "$DB" ] || { echo "backup: DB not found: $DB" >&2; exit 1; }
[ -f "$PUBFILE" ] || { echo "backup: age public key not found: $PUBFILE" >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
TS="$(date +%Y%m%d-%H%M%S)"
NAME="gorifi-db-${TS}-${LABEL}.sqlite.age"
SNAP="$WORK/snap.sqlite"

# 1. Consistent online snapshot of the live WAL database (safe while the app writes).
sqlite3 "$DB" ".backup '$SNAP'"
[ "$(sqlite3 "$SNAP" 'PRAGMA integrity_check;')" = "ok" ] \
  || { echo "backup: snapshot integrity_check FAILED" >&2; exit 1; }

# 2. Encrypt to the age recipient (public key). The server can encrypt but only
#    decrypt if the private key (backup-age-key.txt) is present.
age -R "$PUBFILE" -o "$WORK/$NAME" "$SNAP"

# 3. Push off-host to Google Drive and verify it landed.
rclone copy "$WORK/$NAME" "$REMOTE/" --no-traverse
rclone lsf "$REMOTE/" | grep -qx "$NAME" \
  || { echo "backup: upload verification FAILED for $NAME" >&2; exit 1; }
echo "backup: uploaded $REMOTE/$NAME ($(du -h "$WORK/$NAME" | cut -f1))"

# 4. Retention: prune Drive copies older than KEEP_DAYS.
rclone delete "$REMOTE/" --min-age "${KEEP_DAYS}d" 2>/dev/null || true
