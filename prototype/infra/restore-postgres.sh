#!/usr/bin/env sh
set -eu

# 羲和 PostgreSQL 恢复脚本
# 用法：
#   ./restore-postgres.sh /data/xihe/backups/postgres/xihe_YYYYMMDD_HHMMSS.dump
#
# 注意：恢复会清理并重建数据库对象。执行前请确认已停止 API/Web 写入流量。

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/xihe_backup.dump" >&2
  exit 1
fi

BACKUP_FILE="$1"
ENV_FILE="${XIHE_ENV_FILE:-/data/xihe/config/.env.production}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

RESTORE_NAME="xihe_restore_$(date +%Y%m%d_%H%M%S).dump"

docker cp "$BACKUP_FILE" "xihe-postgres:/tmp/$RESTORE_NAME"

docker exec xihe-postgres pg_restore \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  --no-owner \
  "/tmp/$RESTORE_NAME"

docker exec xihe-postgres rm -f "/tmp/$RESTORE_NAME"

echo "Restore completed from: $BACKUP_FILE"

