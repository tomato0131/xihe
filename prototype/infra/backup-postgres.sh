#!/usr/bin/env sh
set -eu

# 羲和 PostgreSQL 备份脚本
# 建议在服务器上通过 cron 执行：
#   10 2 * * * /data/xihe/app/prototype/infra/backup-postgres.sh

ENV_FILE="${XIHE_ENV_FILE:-/data/xihe/config/.env.production}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

BACKUP_DIR="${XIHE_BACKUP_DIR:-/data/xihe/backups/postgres}"
RETENTION_DAYS="${XIHE_BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/xihe_$TIMESTAMP.dump"

mkdir -p "$BACKUP_DIR"

docker exec xihe-postgres pg_dump \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  -F c \
  -f "/tmp/xihe_$TIMESTAMP.dump"

docker cp "xihe-postgres:/tmp/xihe_$TIMESTAMP.dump" "$BACKUP_FILE"
docker exec xihe-postgres rm -f "/tmp/xihe_$TIMESTAMP.dump"

find "$BACKUP_DIR" -type f -name 'xihe_*.dump' -mtime +"$RETENTION_DAYS" -delete

echo "Backup created: $BACKUP_FILE"
