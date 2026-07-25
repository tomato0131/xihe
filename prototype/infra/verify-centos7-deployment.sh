#!/usr/bin/env sh
set -eu

# 羲和 CentOS 7.9 部署后验收脚本
#
# 在服务器上执行：
#   sh verify-centos7-deployment.sh
#
# 可选环境变量：
#   XIHE_ROOT=/data/xihe
#   XIHE_WEB_PORT=80
#   XIHE_ENV_FILE=/data/xihe/config/.env.production

XIHE_ROOT="${XIHE_ROOT:-/data/xihe}"
APP_ROOT="${XIHE_APP_ROOT:-$XIHE_ROOT/app/prototype}"
INFRA_DIR="$APP_ROOT/infra"
ENV_FILE="${XIHE_ENV_FILE:-$XIHE_ROOT/config/.env.production}"
WEB_PORT="${XIHE_WEB_PORT:-80}"
BASE_URL="${XIHE_BASE_URL:-http://127.0.0.1:$WEB_PORT}"

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS: %s\n' "$*"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf 'WARN: %s\n' "$*" >&2
}

fail_check() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL: %s\n' "$*" >&2
}

have() {
  command -v "$1" >/dev/null 2>&1
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif have docker-compose; then
    docker-compose "$@"
  else
    return 127
  fi
}

load_env() {
  if [ ! -f "$ENV_FILE" ]; then
    fail_check "missing env file: $ENV_FILE"
    return
  fi
  # shellcheck disable=SC1090
  set -a
  . "$ENV_FILE"
  set +a
  pass "env file exists"
}

check_path() {
  path="$1"
  if [ -e "$path" ]; then
    pass "path exists: $path"
  else
    fail_check "missing path: $path"
  fi
}

check_command() {
  name="$1"
  if have "$name"; then
    pass "command available: $name"
  else
    fail_check "command missing: $name"
  fi
}

check_container_running() {
  name="$1"
  if docker ps --format '{{.Names}}' | grep -Fx "$name" >/dev/null 2>&1; then
    pass "container running: $name"
  else
    fail_check "container not running: $name"
  fi
}

check_http() {
  label="$1"
  url="$2"
  if ! have curl; then
    fail_check "curl missing, cannot check $label"
    return
  fi
  if curl -fsS -o /tmp/xihe-verify-http.out "$url"; then
    pass "$label reachable"
  else
    fail_check "$label unreachable: $url"
  fi
  rm -f /tmp/xihe-verify-http.out
}

check_login() {
  if ! have curl; then
    fail_check "curl missing, cannot check admin login"
    return
  fi
  if [ -z "${ADMIN_EMAIL:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
    fail_check "ADMIN_EMAIL or ADMIN_PASSWORD missing in env"
    return
  fi

  payload_file="/tmp/xihe-login-payload.$$"
  response_file="/tmp/xihe-login-response.$$"
  printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" > "$payload_file"

  if curl -fsS -H 'Content-Type: application/json' -d "@$payload_file" "$BASE_URL/api/auth/login" -o "$response_file"; then
    if grep -q '"token"' "$response_file"; then
      pass "admin login works"
    else
      fail_check "admin login response does not contain token"
    fi
  else
    fail_check "admin login request failed"
  fi

  rm -f "$payload_file" "$response_file"
}

check_firewall() {
  if ! have firewall-cmd; then
    warn "firewall-cmd not found"
    return
  fi
  if ! firewall-cmd --state >/dev/null 2>&1; then
    warn "firewalld is not running"
    return
  fi
  if firewall-cmd --list-ports | tr ' ' '\n' | grep -Fx "$WEB_PORT/tcp" >/dev/null 2>&1; then
    pass "firewalld allows $WEB_PORT/tcp"
  else
    warn "firewalld does not list $WEB_PORT/tcp; remote browser may not reach Xihe"
  fi
}

check_selinux() {
  if have getenforce; then
    state="$(getenforce)"
    pass "SELinux state: $state"
  else
    warn "getenforce not found"
  fi
}

check_compose() {
  if [ ! -d "$INFRA_DIR" ]; then
    fail_check "missing infra dir: $INFRA_DIR"
    return
  fi
  cd "$INFRA_DIR"
  if compose -f docker-compose.production.yml ps >/tmp/xihe-compose-ps.out 2>&1; then
    pass "compose ps works"
  else
    fail_check "compose ps failed"
  fi
  rm -f /tmp/xihe-compose-ps.out
}

check_logs() {
  if have docker; then
    docker logs xihe-api --tail 20 >/tmp/xihe-api-log.out 2>&1 || true
    docker logs xihe-postgres --tail 20 >/tmp/xihe-pg-log.out 2>&1 || true
    if grep -Ei 'error|fatal|exception' /tmp/xihe-api-log.out >/dev/null 2>&1; then
      warn "recent xihe-api logs contain error-like words"
    else
      pass "recent xihe-api logs look clean"
    fi
    if grep -Ei 'fatal|panic' /tmp/xihe-pg-log.out >/dev/null 2>&1; then
      warn "recent xihe-postgres logs contain fatal-like words"
    else
      pass "recent xihe-postgres logs look clean"
    fi
    rm -f /tmp/xihe-api-log.out /tmp/xihe-pg-log.out
  fi
}

main() {
  printf '%s\n' "Xihe CentOS 7.9 deployment verification"
  printf '%s\n' "Root: $XIHE_ROOT"
  printf '%s\n' "Base URL: $BASE_URL"
  printf '%s\n' "Env: $ENV_FILE"
  printf '\n'

  check_command docker
  check_command curl
  load_env

  check_path "$XIHE_ROOT"
  check_path "$XIHE_ROOT/config"
  check_path "$XIHE_ROOT/postgres"
  check_path "$XIHE_ROOT/backups/postgres"
  check_path "$XIHE_ROOT/backups/json"
  check_path "$XIHE_ROOT/uploads"
  check_path "$INFRA_DIR/docker-compose.production.yml"

  check_compose
  check_container_running xihe-postgres
  check_container_running xihe-api
  check_container_running xihe-web
  check_container_running xihe-scheduler

  check_http "web homepage" "$BASE_URL/"
  check_http "api health" "$BASE_URL/health"
  check_login
  check_firewall
  check_selinux
  check_logs

  printf '\n'
  printf 'Summary: %s passed, %s warnings, %s failed\n' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  [ "$FAIL_COUNT" -eq 0 ]
}

main "$@"
