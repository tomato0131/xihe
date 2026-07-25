#!/usr/bin/env sh
set -eu

# 羲和本地 -> CentOS 7.9 VM 安全同步脚本草案
#
# 默认只打印计划，不连接服务器：
#   sh sync-to-centos7-vm.sh
#
# 连接服务器但不真正上传：
#   sh sync-to-centos7-vm.sh --dry-run
#
# 确认输出无误后，真正上传：
#   sh sync-to-centos7-vm.sh --apply
#
# 可选环境变量：
#   XIHE_SSH_HOST=SERVER_IP
#   XIHE_SSH_PORT=SSH_PORT
#   XIHE_SSH_USER=root
#   XIHE_REMOTE_APP_DIR=/data/xihe/app
#   XIHE_RSYNC_DELETE=1
#
# 注意：脚本不保存 SSH 密码。需要密码时由 ssh/rsync 交互提示。

MODE="${1:---plan}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"

SSH_HOST="${XIHE_SSH_HOST:-SERVER_IP}"
SSH_PORT="${XIHE_SSH_PORT:-SSH_PORT}"
SSH_USER="${XIHE_SSH_USER:-root}"
REMOTE_APP_DIR="${XIHE_REMOTE_APP_DIR:-/data/xihe/app}"
SSH_TARGET="$SSH_USER@$SSH_HOST"

log() {
  printf '%s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

validate_mode() {
  case "$MODE" in
    --plan|--dry-run|--apply) ;;
    *) fail "Usage: $0 [--plan|--dry-run|--apply]" ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 command not found"
}

main() {
  validate_mode
  require_command ssh
  require_command rsync

  log "Xihe sync to CentOS 7.9 VM"
  log "Mode: $MODE"
  log "Local project: $PROJECT_ROOT"
  log "Remote: $SSH_TARGET:$REMOTE_APP_DIR/"
  log "SSH port: $SSH_PORT"
  log

  if [ "$MODE" = "--apply" ]; then
    ssh -p "$SSH_PORT" -o StrictHostKeyChecking=accept-new "$SSH_TARGET" "mkdir -p '$REMOTE_APP_DIR'"
  elif [ "$MODE" = "--plan" ]; then
    log "+ ssh -p $SSH_PORT $SSH_TARGET \"mkdir -p '$REMOTE_APP_DIR'\""
  else
    log "Dry-run mode: no remote directory will be created."
  fi

  DRY_RUN_FLAG=""
  if [ "$MODE" = "--dry-run" ]; then
    DRY_RUN_FLAG="--dry-run"
  fi
  if [ "$MODE" = "--plan" ]; then
    DRY_RUN_FLAG="--dry-run"
  fi

  DELETE_FLAG=""
  if [ "${XIHE_RSYNC_DELETE:-0}" = "1" ]; then
    DELETE_FLAG="--delete"
  fi

  log "+ rsync project files"
  if [ "$MODE" = "--plan" ]; then
    log "rsync -az --dry-run $DELETE_FLAG --human-readable --stats --progress \\"
    log "  -e \"ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new\" \\"
    log "  --exclude '.git/' --exclude '.DS_Store' \\"
    log "  --exclude 'node_modules/' --exclude 'dist/' --exclude '.local/' --exclude '.npm-cache/' \\"
    log "  --exclude 'prototype/node_modules/' --exclude 'prototype/dist/' \\"
    log "  --exclude 'prototype/.local/' --exclude 'prototype/.npm-cache/' \\"
    log "  --exclude 'prototype/infra/.env.local' --exclude 'prototype/infra/.env.production' \\"
    log "  \"$PROJECT_ROOT/\" \"$SSH_TARGET:$REMOTE_APP_DIR/\""
  else
    rsync -az $DRY_RUN_FLAG $DELETE_FLAG \
      --human-readable \
      --stats \
      --progress \
      -e "ssh -p $SSH_PORT -o StrictHostKeyChecking=accept-new" \
      --exclude '.git/' \
      --exclude '.DS_Store' \
      --exclude 'node_modules/' \
      --exclude 'dist/' \
      --exclude '.local/' \
      --exclude '.npm-cache/' \
      --exclude 'prototype/node_modules/' \
      --exclude 'prototype/dist/' \
      --exclude 'prototype/.local/' \
      --exclude 'prototype/.npm-cache/' \
      --exclude 'prototype/infra/.env.local' \
      --exclude 'prototype/infra/.env.production' \
      "$PROJECT_ROOT/" \
      "$SSH_TARGET:$REMOTE_APP_DIR/"
  fi

  log
  if [ "$MODE" = "--plan" ]; then
    log "Plan finished. No server connection was made."
    log "To connect but not upload: sh $SCRIPT_DIR/sync-to-centos7-vm.sh --dry-run"
    log "To upload for real: sh $SCRIPT_DIR/sync-to-centos7-vm.sh --apply"
  elif [ "$MODE" = "--dry-run" ]; then
    log "Dry-run finished. Server was contacted, but no files were uploaded."
    log "To upload for real: sh $SCRIPT_DIR/sync-to-centos7-vm.sh --apply"
  else
    log "Sync finished."
    log "Next on server:"
    log "  cd $REMOTE_APP_DIR/prototype/infra"
    log "  sh deploy-centos7.sh"
  fi
}

main "$@"
