#!/usr/bin/env sh
set -eu

# 羲和 CentOS 7.9 部署执行脚本草案
#
# 默认只演练并打印检查结果，不真正启动服务：
#   sh deploy-centos7.sh
#
# 确认配置无误后，在服务器执行：
#   sh deploy-centos7.sh --apply
#
# 可选环境变量：
#   XIHE_ROOT=/data/xihe
#   XIHE_WEB_PORT=80
#   XIHE_OPEN_FIREWALL=1

MODE="${1:---dry-run}"
XIHE_ROOT="${XIHE_ROOT:-/data/xihe}"
APP_ROOT="${XIHE_APP_ROOT:-$XIHE_ROOT/app/prototype}"
INFRA_DIR="$APP_ROOT/infra"
ENV_FILE="${XIHE_ENV_FILE:-$XIHE_ROOT/config/.env.production}"
WEB_PORT="${XIHE_WEB_PORT:-80}"

log() {
  printf '%s\n' "$*"
}

run() {
  log "+ $*"
  if [ "$MODE" = "--apply" ]; then
    "$@"
  fi
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    fail "Docker Compose is not available. Install Docker Compose v2 first."
  fi
}

validate_mode() {
  case "$MODE" in
    --dry-run|--apply) ;;
    *) fail "Usage: $0 [--dry-run|--apply]" ;;
  esac
}

validate_location() {
  [ -d "$INFRA_DIR" ] || fail "Infra directory not found: $INFRA_DIR"
  [ -f "$INFRA_DIR/docker-compose.production.yml" ] || fail "Missing docker-compose.production.yml"
  [ -f "$INFRA_DIR/.env.production.example" ] || fail "Missing .env.production.example"
}

validate_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    log "Production env file not found: $ENV_FILE"
    log "Create it with:"
    log "  sh $INFRA_DIR/create-production-env.sh"
    exit 2
  fi

  if grep -E 'CHANGE_ME|example\.com' "$ENV_FILE" >/dev/null 2>&1; then
    fail "Env file still contains placeholder values. Edit: $ENV_FILE"
  fi

  required_vars='POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL SESSION_SECRET ADMIN_EMAIL ADMIN_PASSWORD ADMIN_DISPLAY_NAME ALLOWED_ORIGINS'
  for name in $required_vars; do
    if ! grep -E "^$name=.+" "$ENV_FILE" >/dev/null 2>&1; then
      fail "Missing required env var: $name"
    fi
  done
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker command not found"

  if command -v systemctl >/dev/null 2>&1; then
    if ! systemctl is-active docker >/dev/null 2>&1; then
      run systemctl start docker
    fi
    run systemctl enable docker
  fi

  docker version >/dev/null 2>&1 || fail "Docker daemon is not available"
  compose version >/dev/null 2>&1 || fail "Docker Compose check failed"
}

open_firewall_if_requested() {
  if ! command -v firewall-cmd >/dev/null 2>&1; then
    log "firewall-cmd not found, skip firewalld handling."
    return
  fi

  if ! firewall-cmd --state >/dev/null 2>&1; then
    log "firewalld is not running, skip firewalld handling."
    return
  fi

  if [ "${XIHE_OPEN_FIREWALL:-0}" = "1" ]; then
    run firewall-cmd --permanent "--add-port=$WEB_PORT/tcp"
    run firewall-cmd --reload
  else
    log "firewalld is running. If remote browser cannot open Xihe, run:"
    log "  firewall-cmd --permanent --add-port=$WEB_PORT/tcp"
    log "  firewall-cmd --reload"
  fi
}

health_check() {
  if command -v curl >/dev/null 2>&1; then
    run curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/"
    run curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/health"
  else
    log "curl not found, skip HTTP health check."
  fi
}

main() {
  validate_mode

  log "Xihe CentOS 7.9 deployment script"
  log "Mode: $MODE"
  log "Root: $XIHE_ROOT"
  log "Infra: $INFRA_DIR"
  log "Env: $ENV_FILE"
  log

  validate_location

  run sh "$INFRA_DIR/centos7-preflight.sh"
  run sh "$INFRA_DIR/init-server-dirs.sh"
  validate_env_file
  ensure_docker
  open_firewall_if_requested

  run cd "$INFRA_DIR"
  if [ "$MODE" = "--apply" ]; then
    cd "$INFRA_DIR"
  fi

  run compose -f docker-compose.production.yml config --quiet
  run compose -f docker-compose.production.yml up -d --build
  run compose -f docker-compose.production.yml ps
  run compose -f docker-compose.production.yml exec api node server/bootstrap-admin.mjs
  health_check

  log
  log "Deployment flow completed."
  log "Open: http://服务器IP:$WEB_PORT"
}

main "$@"
