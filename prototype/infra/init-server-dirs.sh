#!/usr/bin/env sh
set -eu

# 羲和服务器目录初始化脚本
# 用法：
#   sh init-server-dirs.sh
# 或指定根目录：
#   XIHE_ROOT=/data/xihe sh init-server-dirs.sh

XIHE_ROOT="${XIHE_ROOT:-/data/xihe}"

mkdir -p "$XIHE_ROOT/app"
mkdir -p "$XIHE_ROOT/config"
mkdir -p "$XIHE_ROOT/postgres"
mkdir -p "$XIHE_ROOT/uploads"
mkdir -p "$XIHE_ROOT/backups/postgres"
mkdir -p "$XIHE_ROOT/backups/json"
mkdir -p "$XIHE_ROOT/backups/config"
mkdir -p "$XIHE_ROOT/logs/api"
mkdir -p "$XIHE_ROOT/logs/web"
mkdir -p "$XIHE_ROOT/logs/scheduler"
mkdir -p "$XIHE_ROOT/releases"

chmod 700 "$XIHE_ROOT/config"
chmod 700 "$XIHE_ROOT/backups"
chmod 700 "$XIHE_ROOT/backups/postgres"
chmod 700 "$XIHE_ROOT/backups/json"
chmod 700 "$XIHE_ROOT/backups/config"

echo "Xihe directories are ready under: $XIHE_ROOT"
echo
echo "Next steps:"
echo "1. Sync application files into: $XIHE_ROOT/app"
echo "2. Copy env example to: $XIHE_ROOT/config/.env.production"
echo "3. Edit real secrets only on the server"

