#!/usr/bin/env sh
set -eu

# 羲和 CentOS 7.9 部署前检查脚本
# 只做检查，不安装软件、不修改系统。

echo "== OS =="
if [ -f /etc/centos-release ]; then
  cat /etc/centos-release
else
  echo "WARN: /etc/centos-release not found"
fi
uname -r
echo

echo "== Time =="
date
if command -v timedatectl >/dev/null 2>&1; then
  timedatectl status | sed -n '1,8p' || true
fi
echo

echo "== Disk =="
df -h /data 2>/dev/null || df -h /
echo

echo "== Docker =="
if command -v docker >/dev/null 2>&1; then
  docker version --format 'Client: {{.Client.Version}} | Server: {{.Server.Version}}' 2>/dev/null || docker version
else
  echo "MISSING: docker"
fi
echo

echo "== Docker Compose =="
if docker compose version >/dev/null 2>&1; then
  docker compose version
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose version
  echo "WARN: detected legacy docker-compose. Prefer Docker Compose v2: docker compose ..."
else
  echo "MISSING: docker compose"
fi
echo

echo "== Docker service =="
if command -v systemctl >/dev/null 2>&1; then
  systemctl is-enabled docker 2>/dev/null || true
  systemctl is-active docker 2>/dev/null || true
fi
echo

echo "== firewalld =="
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --state 2>/dev/null || true
  firewall-cmd --list-ports 2>/dev/null || true
else
  echo "firewall-cmd not found"
fi
echo

echo "== SELinux =="
if command -v getenforce >/dev/null 2>&1; then
  getenforce
else
  echo "getenforce not found"
fi
echo

echo "== Xihe directories =="
for path in /data /data/xihe /data/xihe/config /data/xihe/postgres /data/xihe/backups /data/xihe/uploads; do
  if [ -e "$path" ]; then
    ls -ld "$path"
  else
    echo "MISSING: $path"
  fi
done
echo

echo "Preflight finished."

