# 羲和生产部署说明草案

> 当前文件是阶段 C 的部署骨架说明，不包含真实服务器密码和真实密钥。

当前目标服务器为 CentOS 7.9。部署前请先阅读 [CENTOS7_9_DEPLOYMENT.md](./CENTOS7_9_DEPLOYMENT.md)，重点确认 Docker Compose v2、firewalld、SELinux 和 `/data` 挂载目录。

## 1. 推荐目录

服务器上统一使用：

```text
/data/xihe
├── app
├── releases
├── config
├── postgres
├── uploads
├── backups
│   ├── postgres
│   └── json
└── logs
```

## 2. 初始化目录

推荐使用脚本：

```bash
sh /data/xihe/app/prototype/infra/centos7-preflight.sh
sh /data/xihe/app/prototype/infra/init-server-dirs.sh
```

脚本会创建以下目录：

```bash
mkdir -p /data/xihe/app
mkdir -p /data/xihe/releases
mkdir -p /data/xihe/config
mkdir -p /data/xihe/postgres
mkdir -p /data/xihe/uploads
mkdir -p /data/xihe/backups/postgres
mkdir -p /data/xihe/backups/json
mkdir -p /data/xihe/backups/config
mkdir -p /data/xihe/logs/api
mkdir -p /data/xihe/logs/web
mkdir -p /data/xihe/logs/scheduler
```

## 3. 准备配置

推荐使用脚本生成生产配置：

```bash
cd /data/xihe/app/prototype/infra
sh create-production-env.sh
```

如果需要手工创建，也可以复制示例配置：

```bash
cp /data/xihe/app/prototype/infra/.env.production.example /data/xihe/config/.env.production
```

然后编辑 `/data/xihe/config/.env.production`，至少替换：

- `POSTGRES_PASSWORD`
- `DATABASE_URL` 中的密码
- `SESSION_SECRET`
- `ALLOWED_ORIGINS`
- `REMINDER_EMAIL`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_DISPLAY_NAME`

真实 webhook、密码、密钥只允许保存在服务器配置文件中，不提交到 Git。

## 4. 启动服务

在应用目录执行：

```bash
cd /data/xihe/app/prototype/infra
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
```

默认前端测试端口为：

```text
http://服务器IP:8080
```

后续正式上线时，可以把 `web` 服务接到 80/443，并配置域名和 HTTPS。

## 5. 健康检查

```bash
curl -sS http://127.0.0.1:8080/
curl -sS http://127.0.0.1:8080/health
sh /data/xihe/app/prototype/infra/verify-centos7-deployment.sh
```

如果 API 不通，优先查看：

```bash
docker logs xihe-api --tail 100
docker logs xihe-postgres --tail 100
```

## 6. 初始化试运行管理员账号

当前阶段还没有正式后台用户管理页面。内网试运行时，可以使用管理员初始化脚本创建第一个登录账号：

```bash
cd /data/xihe/app/prototype/infra
docker compose -f docker-compose.production.yml exec api node server/bootstrap-admin.mjs
```

它会根据 `/data/xihe/config/.env.production` 里的配置创建或更新管理员账号：

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_DISPLAY_NAME`

这个脚本可以重复执行。如果邮箱已存在，会更新该账号的密码和显示名。后续进入正式上线前，建议继续开发“后台用户管理”能力。

## 7. 备份

手动执行一次 PostgreSQL 备份：

```bash
sh /data/xihe/app/prototype/infra/backup-postgres.sh
```

建议加入 cron：

```cron
10 2 * * * /data/xihe/app/prototype/infra/backup-postgres.sh >> /data/xihe/logs/scheduler/backup.log 2>&1
```

备份文件默认保存在：

```text
/data/xihe/backups/postgres
```

## 8. 恢复

恢复前建议先停止 API/Web 写入流量：

```bash
cd /data/xihe/app/prototype/infra
docker compose -f docker-compose.production.yml stop api web scheduler
```

执行恢复：

```bash
sh /data/xihe/app/prototype/infra/restore-postgres.sh /data/xihe/backups/postgres/xihe_YYYYMMDD_HHMMSS.dump
```

恢复后启动服务：

```bash
docker compose -f docker-compose.production.yml up -d
```

## 9. 当前阶段注意事项

- 当前 compose 是阶段 C 草案，适合内网测试和小范围试运行。
- PostgreSQL 不建议暴露公网。
- 企业微信推送暂不作为必选能力，默认仍以产品内提醒为主。
- 上传图片/文档能力尚未正式开发，但已预留 `/data/xihe/uploads`。
- 正式上线前，需要补充后台用户管理、密码修改和权限控制。
- 后续上线公网访问时，需要补充 HTTPS、访问控制和服务器防火墙策略。

## 10. 部署前检查清单

真正连接服务器前，建议先按 [PRE_DEPLOY_CHECKLIST.md](./PRE_DEPLOY_CHECKLIST.md) 逐项检查。

如果需要一份从本地同步到服务器验收的完整执行顺序，使用 [RUNBOOK_CENTOS7_DEPLOY.md](./RUNBOOK_CENTOS7_DEPLOY.md)。

本地同步到 CentOS 7.9 VM 时，优先使用：

```bash
cd /Users/tyrion/Documents/员工关怀-生日提醒/prototype/infra
sh sync-to-centos7-vm.sh
sh sync-to-centos7-vm.sh --dry-run
sh sync-to-centos7-vm.sh --apply
```

部署完成后，执行：

```bash
cd /data/xihe/app/prototype/infra
sh verify-centos7-deployment.sh
```
