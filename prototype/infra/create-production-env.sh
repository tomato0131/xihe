#!/usr/bin/env sh
set -eu

# 羲和生产配置生成助手
#
# 在服务器上执行：
#   sh create-production-env.sh
#
# 如果 /data/xihe/config/.env.production 已存在，默认不会覆盖。
# 如确需覆盖：
#   sh create-production-env.sh --force

MODE="${1:-}"
XIHE_ROOT="${XIHE_ROOT:-/data/xihe}"
ENV_FILE="${XIHE_ENV_FILE:-$XIHE_ROOT/config/.env.production}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

ask() {
  prompt="$1"
  default="$2"
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  read -r value
  if [ -z "$value" ]; then
    value="$default"
  fi
  printf '%s' "$value"
}

ask_generated_secret() {
  prompt="$1"
  default="$2"
  printf '%s [auto-generated hidden]: ' "$prompt" >&2
  read -r value
  if [ -z "$value" ]; then
    value="$default"
  fi
  printf '%s' "$value"
}

random_secret() {
  length="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$length" | tr -d '\n' | tr '/+' 'Aa' | cut -c "1-$length"
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$length"
  fi
}

validate_mode() {
  case "$MODE" in
    ""|--force) ;;
    *) fail "Usage: $0 [--force]" ;;
  esac
}

validate_email() {
  email="$1"
  printf '%s' "$email" | grep -E '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' >/dev/null 2>&1
}

validate_number() {
  value="$1"
  printf '%s' "$value" | grep -E '^[0-9]+$' >/dev/null 2>&1
}

main() {
  validate_mode

  if [ -f "$ENV_FILE" ] && [ "$MODE" != "--force" ]; then
    fail "$ENV_FILE already exists. Use --force only if you really want to overwrite it."
  fi

  mkdir -p "$(dirname "$ENV_FILE")"
  chmod 700 "$(dirname "$ENV_FILE")"

  printf '%s\n' "Xihe production env generator"
  printf '%s\n' "Target: $ENV_FILE"
  printf '%s\n' "Press Enter to accept defaults."
  printf '\n'

  postgres_db="$(ask 'PostgreSQL database name' 'xihe')"
  postgres_user="$(ask 'PostgreSQL username' 'xihe_app')"
  postgres_password="$(ask_generated_secret 'PostgreSQL password' "$(random_secret 36)")"
  api_port="$(ask 'API internal port' '8787')"
  web_origin="$(ask 'Allowed browser origin' 'http://127.0.0.1:8080')"
  admin_email="$(ask 'Admin email' 'admin@example.com')"
  admin_display_name="$(ask 'Admin display name' '羲和管理员')"
  admin_password="$(ask_generated_secret 'Admin password' "$(random_secret 24)")"
  wechat_appid="$(ask 'WeChat Mini Program AppID, optional' '')"
  wechat_secret="$(ask_generated_secret 'WeChat Mini Program Secret, optional' '')"
  backup_retention_days="$(ask 'PostgreSQL backup retention days' '30')"

  validate_email "$admin_email" || fail "Invalid admin email: $admin_email"
  validate_number "$api_port" || fail "API port must be a number: $api_port"
  validate_number "$backup_retention_days" || fail "Backup retention days must be a number: $backup_retention_days"
  [ "${#admin_password}" -ge 12 ] || fail "Admin password must contain at least 12 characters"
  [ "${#postgres_password}" -ge 16 ] || fail "PostgreSQL password must contain at least 16 characters"

  session_secret="$(random_secret 64)"
  database_url="postgres://$postgres_user:$postgres_password@postgres:5432/$postgres_db"

  tmp_file="$ENV_FILE.tmp.$$"
  umask 077
  {
    printf '%s\n' '# 羲和生产环境配置'
    printf '%s\n' '# 由 create-production-env.sh 生成。不要提交到 Git。'
    printf '%s\n' ''
    printf '%s\n' 'TZ=Asia/Shanghai'
    printf '%s\n' 'PGTZ=Asia/Shanghai'
    printf '%s\n' "POSTGRES_DB=$postgres_db"
    printf '%s\n' "POSTGRES_USER=$postgres_user"
    printf '%s\n' "POSTGRES_PASSWORD=$postgres_password"
    printf '%s\n' ''
    printf '%s\n' 'API_HOST=0.0.0.0'
    printf '%s\n' "API_PORT=$api_port"
    printf '%s\n' "DATABASE_URL=$database_url"
    printf '%s\n' "SESSION_SECRET=$session_secret"
    printf '%s\n' "ALLOWED_ORIGINS=$web_origin"
    printf '%s\n' 'BACKUP_DIR=/data/xihe/backups/json'
    printf '%s\n' ''
    printf '%s\n' 'DEFAULT_NOTIFICATION_CHANNELS=in_app'
    if [ -n "$wechat_appid" ]; then
      printf '%s\n' "WECHAT_MINIPROGRAM_APPID=$wechat_appid"
    fi
    if [ -n "$wechat_secret" ]; then
      printf '%s\n' "WECHAT_MINIPROGRAM_SECRET=$wechat_secret"
    fi
    printf '%s\n' '# WECOM_BOT_WEBHOOK='
    printf '%s\n' ''
    printf '%s\n' 'XIHE_API_BASE=http://api:8787'
    printf '%s\n' "REMINDER_EMAIL=$admin_email"
    printf '%s\n' ''
    printf '%s\n' "ADMIN_EMAIL=$admin_email"
    printf '%s\n' "ADMIN_PASSWORD=$admin_password"
    printf '%s\n' "ADMIN_DISPLAY_NAME=$admin_display_name"
    printf '%s\n' '# ADMIN_USER_ID='
    printf '%s\n' ''
    printf '%s\n' 'XIHE_BACKUP_DIR=/data/xihe/backups/postgres'
    printf '%s\n' "XIHE_BACKUP_RETENTION_DAYS=$backup_retention_days"
  } > "$tmp_file"

  mv "$tmp_file" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  printf '\n'
  printf '%s\n' "Created: $ENV_FILE"
  printf '%s\n' "Admin email: $admin_email"
  printf '%s\n' "Keep the generated admin password in a secure place."
}

main "$@"
