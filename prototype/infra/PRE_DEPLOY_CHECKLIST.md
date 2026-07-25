# 羲和服务器部署前检查清单

> 用途：真正连接虚拟机部署前，先按这张清单确认环境、配置、备份和回滚路径。此文件不包含真实密码。

## 1. 服务器基础条件

- [ ] 已确认服务器系统为 CentOS 7.9。
- [ ] 能通过 SSH 登录服务器。
- [ ] 服务器 `/data` 目录存在且可写。
- [ ] 已确认 `/data` 可用磁盘空间足够。
- [ ] 服务器时间和时区正常，建议使用 `Asia/Shanghai`。
- [ ] Docker 已安装。
- [ ] Docker Compose v2 可用，优先使用 `docker compose`。
- [ ] firewalld 策略明确：SSH 仅管理访问，Web 试运行开放 `8080/tcp`，PostgreSQL 不对公网开放。
- [ ] 已检查 SELinux 状态；如为 `Enforcing`，需关注 `/data/xihe` 挂载目录标签。

参考检查命令：

```bash
cat /etc/centos-release
uname -r
df -h /data
date
docker version
docker compose version
getenforce
firewall-cmd --state
```

CentOS 7.9 细节见 [CENTOS7_9_DEPLOYMENT.md](./CENTOS7_9_DEPLOYMENT.md)。

## 2. 目录准备

建议先在服务器执行 CentOS 7.9 预检：

```bash
cd /data/xihe/app/prototype/infra
sh centos7-preflight.sh
sh init-server-dirs.sh
```

预期目录：

```text
/data/xihe/app
/data/xihe/config
/data/xihe/postgres
/data/xihe/uploads
/data/xihe/backups/postgres
/data/xihe/backups/json
/data/xihe/logs/api
/data/xihe/logs/web
/data/xihe/logs/scheduler
```

## 3. 配置准备

- [ ] 已在服务器使用配置生成助手创建 `/data/xihe/config/.env.production`：

```bash
cd /data/xihe/app/prototype/infra
sh create-production-env.sh
```

- [ ] 已替换 `POSTGRES_PASSWORD`。
- [ ] 已同步替换 `DATABASE_URL` 中的数据库密码。
- [ ] 已替换 `SESSION_SECRET`，长度不少于 32 个字符。
- [ ] 已填写 `ADMIN_EMAIL`。
- [ ] 已填写 `ADMIN_PASSWORD`，长度不少于 12 个字符。
- [ ] 已填写 `ADMIN_DISPLAY_NAME`。
- [ ] 已按访问地址设置 `ALLOWED_ORIGINS`。
- [ ] 如暂不启用企业微信，保持 `WECOM_BOT_WEBHOOK` 为空或注释。

注意：

- 真实 `.env.production` 只放服务器 `/data/xihe/config`。
- 不要把真实 `.env.production` 复制回本地项目目录。
- 不要把 webhook、数据库密码、管理员密码写入文档或 Git。

## 4. 应用文件准备

- [ ] 当前本地代码已通过 `npm run build`。
- [ ] 当前本地 API smoke test 已通过。
- [ ] 已确认没有真实 webhook 或密钥进入仓库。
- [ ] 已先查看同步计划，不连接服务器：

```bash
cd /Users/tyrion/Documents/员工关怀-生日提醒/prototype/infra
sh sync-to-centos7-vm.sh
```

- [ ] 已 dry-run 检查远端同步内容，不真正上传：

```bash
sh sync-to-centos7-vm.sh --dry-run
```

- [ ] 已把应用文件同步到 `/data/xihe/app`：

```bash
sh sync-to-centos7-vm.sh --apply
```

- [ ] 已确认服务器上的 `prototype/infra/docker-compose.production.yml` 存在。

本地同步时建议排除：

```text
node_modules
dist
.local
.npm-cache
infra/.env.local
infra/.env.production
```

## 5. 首次启动顺序

- [ ] 先演练部署脚本：

```bash
cd /data/xihe/app/prototype/infra
sh deploy-centos7.sh
```

- [ ] 如 firewalld 开启，开放 Web 测试端口：

```bash
firewall-cmd --permanent --add-port=8080/tcp
firewall-cmd --reload
```

- [ ] 启动服务：

```bash
cd /data/xihe/app/prototype/infra
docker compose -f docker-compose.production.yml up -d --build
```

- [ ] 查看服务状态：

```bash
docker compose -f docker-compose.production.yml ps
```

- [ ] 初始化管理员账号：

```bash
docker compose -f docker-compose.production.yml exec api node server/bootstrap-admin.mjs
```

- [ ] 访问页面：

```text
http://服务器IP:8080
```

- [ ] 登录管理员账号。

## 6. 健康检查

- [ ] 已执行部署后验收脚本：

```bash
cd /data/xihe/app/prototype/infra
sh verify-centos7-deployment.sh
```

- [ ] 前端首页可打开。
- [ ] API 健康检查可访问。
- [ ] 登录成功。
- [ ] 可以新增一条人员记录。
- [ ] 可以查看生日提醒。
- [ ] 可以新增一条关怀记录。
- [ ] 可以导出 JSON 备份。

参考命令：

```bash
curl -sS http://127.0.0.1:8080/
curl -sS http://127.0.0.1:8080/health
docker logs xihe-api --tail 100
docker logs xihe-postgres --tail 100
```

## 7. 备份检查

- [ ] 手动执行一次 PostgreSQL 备份。
- [ ] 已确认备份文件出现在 `/data/xihe/backups/postgres`。
- [ ] 已配置 cron 每日备份。
- [ ] 已确认 cron 日志写入 `/data/xihe/logs/scheduler/backup.log`。
- [ ] 后续找时间做一次恢复演练。

手动备份：

```bash
sh /data/xihe/app/prototype/infra/backup-postgres.sh
```

cron 示例：

```cron
10 2 * * * /data/xihe/app/prototype/infra/backup-postgres.sh >> /data/xihe/logs/scheduler/backup.log 2>&1
```

## 8. 回滚与停机预案

如果启动失败：

```bash
cd /data/xihe/app/prototype/infra
docker compose -f docker-compose.production.yml logs --tail 200
docker compose -f docker-compose.production.yml down
```

如果需要恢复数据库：

```bash
docker compose -f docker-compose.production.yml stop api web scheduler
sh /data/xihe/app/prototype/infra/restore-postgres.sh /data/xihe/backups/postgres/xihe_YYYYMMDD_HHMMSS.dump
docker compose -f docker-compose.production.yml up -d
```

## 9. 暂不做事项

阶段 C 先不做这些事，避免复杂度过早上来：

- 暂不引入 Kubernetes。
- 暂不引入 MinIO，文件上传能力正式开发后再评估。
- 暂不开放 PostgreSQL 公网端口。
- 暂不把企业微信推送作为上线前置条件。
- 暂不开发完整后台管理系统。
