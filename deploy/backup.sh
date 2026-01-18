#!/bin/bash
# Gorifi Database Backup Script
# Run this on the server, or add to crontab

set -e

BACKUP_DIR="/var/backups/gorifi"
DB_PATH="/var/www/gorifi/backend/src/db/database.sqlite"
KEEP_DAYS=30

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Create backup with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/gorifi_$TIMESTAMP.sqlite"

if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "$BACKUP_FILE"
  echo "Backup created: $BACKUP_FILE"

  # Compress the backup
  gzip "$BACKUP_FILE"
  echo "Compressed: $BACKUP_FILE.gz"
else
  echo "Warning: Database file not found at $DB_PATH"
  exit 1
fi

# Remove backups older than KEEP_DAYS
find "$BACKUP_DIR" -name "gorifi_*.sqlite.gz" -mtime +$KEEP_DAYS -delete
echo "Cleaned up backups older than $KEEP_DAYS days"

# Show backup status
echo ""
echo "Current backups:"
ls -lh "$BACKUP_DIR"/*.gz 2>/dev/null || echo "No backups found"
