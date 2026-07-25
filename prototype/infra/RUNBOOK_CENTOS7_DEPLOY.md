# 羲和 CentOS 7.9 服务器部署操作手册 v1

> 适用场景：把当前本地羲和原型部署到 CentOS 7.9 虚拟机，程序、数据、备份均放在 `/data` 目录下。

## 0. 部署边界

本手册默认：

- 服务器系统：CentOS 7.9。
- 应用根目录：`/data/xihe/app`。
- 生产配置：`/data/xihe/config/.env.production`。
- PostgreSQL 数据：`/data/xihe/postgres`。
- Docker 数据根目录：`/data/docker`。
- PostgreSQL 运行数据：Docker managed volume `xihe-postgres-data`，物理落点在 `/data/docker/volumes/xihe-postgres-data/_data`。
- 备份目录：`/data/xihe/backups`。
- Web 测试端口：`8080/tcp`。
- PostgreSQL 不对公网开放。
- 企业微信推送暂不作为上线前置条件。

本手册不会要求把真实密码、webhook 或 `.env.production` 提交到 Git。

## 1. 本地部署前确认

在本地执行：

```bash
cd /Users/tyrion/Documents/员工关怀-生日提醒/prototype
npm run build
npm run test:api
```

再做敏感信息扫描：

```bash
cd /Users/tyrion/Documents/员工关怀-生日提醒
rg -n "真实密码|真实 webhook|旧部署路径|旧健康接口" prototype/infra docs --glob '!**/.env.local'
```

预期：

- `npm run build` 成功。
- `npm run test:api` 成功。
- 敏感信息扫描没有输出。

## 2. 本地查看同步计划

先只打印计划，不连接服务器：

```bash
cd /Users/tyrion/Documents/员工关怀-生日提醒/prototype/infra
sh sync-to-centos7-vm.sh
```

确认目标类似：

```text
DEPLOY_USER@SERVER_IP:/data/xihe/app/
SSH port: SSH_PORT
```

确认排除项包含：

```text
node_modules
dist
.local
.npm-cache
prototype/infra/.env.local
prototype/infra/.env.production
```

## 3. 连接服务器但不上传

执行 dry-run：

```bash
sh sync-to-centos7-vm.sh --dry-run
```

这一步会连接服务器，但不会真正上传文件。用于确认：

- SSH 可达。
- 端口正确。
- 远端路径正确。
- rsync 输出符合预期。

## 4. 同步应用文件到服务器

确认 dry-run 没问题后执行：

```bash
sh sync-to-centos7-vm.sh --apply
```

同步完成后，服务器上应该存在：

```text
/data/xihe/app/prototype/infra
```

## 5. 服务器预检

登录服务器后执行：

```bash
cd /data/xihe/app/prototype/infra
sh centos7-preflight.sh
```

重点检查：

- 系统是否为 CentOS 7.9。
- `/data` 磁盘空间是否充足。
- Docker 是否可用。
- Docker Compose 是否可用。
- Docker 服务是否 active。
- firewalld 是否运行。
- SELinux 状态。

如果 Docker 或 Compose 不可用，先不要继续部署。

## 6. 初始化目录

```bash
sh init-server-dirs.sh
```

预期创建：

```text
/data/xihe/app
/data/xihe/releases
/data/xihe/config
/data/xihe/postgres
/data/xihe/uploads
/data/xihe/backups/postgres
/data/xihe/backups/json
/data/xihe/backups/config
/data/xihe/logs/api
/data/xihe/logs/web
/data/xihe/logs/scheduler
```

## 7. 生成生产配置

执行：

```bash
sh create-production-env.sh
```

它会生成：

```text
/data/xihe/config/.env.production
```

请记录好脚本生成的管理员账号和密码。该文件不要复制回本地，不要提交到 Git。

如果文件已存在，脚本默认不会覆盖。确实要重建配置时才使用：

```bash
sh create-production-env.sh --force
```

## 8. 部署脚本演练

先 dry-run：

```bash
sh deploy-centos7.sh
```

预期：

- 能找到 `/data/xihe/config/.env.production`。
- 不再提示 `CHANGE_ME` 或 `example.com`。
- 能检查 Docker / Compose。
- 只打印将要执行的部署动作，不真正启动服务。

## 9. 开放 Web 测试端口

如果 firewalld 开启，开放 `8080/tcp`：

```bash
firewall-cmd --permanent --add-port=8080/tcp
firewall-cmd --reload
firewall-cmd --list-ports
```

不要开放：

```text
5432/tcp
8787/tcp
```

## 10. 正式启动服务

推荐使用部署脚本：

```bash
sh deploy-centos7.sh --apply
```

如果希望脚本自动处理 firewalld 的 `8080/tcp`：

```bash
XIHE_OPEN_FIREWALL=1 sh deploy-centos7.sh --apply
```

该脚本会执行：

- CentOS 预检。
- 目录初始化。
- `.env.production` 检查。
- Docker / Compose 检查。
- `docker compose config --quiet`。
- `docker compose up -d --build`。
- 初始化管理员账号。
- 本机健康检查。

## 11. 查看服务状态

```bash
docker compose -f docker-compose.production.yml ps
docker ps
```

预期容器：

```text
xihe-postgres
xihe-api
xihe-web
xihe-scheduler
```

## 12. 部署后验收

执行：

```bash
sh verify-centos7-deployment.sh
```

它会检查：

- 容器是否运行。
- 前端是否可访问。
- `/health` 是否可访问。
- 管理员账号是否能登录。
- firewalld 是否开放 `8080/tcp`。
- SELinux 状态。
- 最近日志是否有明显 fatal/error。

也可以手动检查：

```bash
curl -sS http://127.0.0.1:8080/
curl -sS http://127.0.0.1:8080/health
docker logs xihe-api --tail 100
docker logs xihe-postgres --tail 100
```

## 13. 浏览器访问

在本机浏览器打开：

```text
http://SERVER_IP:8080
```

使用 `create-production-env.sh` 生成的管理员账号登录。

登录后至少验证：

- 可以进入首页。
- 可以新增一条人员记录。
- 可以查看提醒中心。
- 可以新增一条关怀记录。
- 可以执行 JSON 导出。

## 14. 手动备份一次

部署成功后立即做一次数据库备份：

```bash
sh /data/xihe/app/prototype/infra/backup-postgres.sh
ls -lh /data/xihe/backups/postgres
```

预期出现：

```text
xihe_YYYYMMDD_HHMMSS.dump
```

## 15. 配置每日备份

编辑 cron：

```bash
crontab -e
```

加入：

```cron
10 2 * * * /data/xihe/app/prototype/infra/backup-postgres.sh >> /data/xihe/logs/scheduler/backup.log 2>&1
```

查看：

```bash
crontab -l
```

## 16. 常见问题处理

### 16.1 页面打不开

检查：

```bash
docker ps
firewall-cmd --list-ports
curl -sS http://127.0.0.1:8080/
```

如果本机 curl 通、外部浏览器不通，多半是防火墙未开放 `8080/tcp`。

### 16.2 API 健康检查失败

检查：

```bash
curl -sS http://127.0.0.1:8080/health
docker logs xihe-api --tail 100
docker logs xihe-postgres --tail 100
```

常见原因：

- 数据库没起来。
- `.env.production` 中 `DATABASE_URL` 不正确。
- PostgreSQL 密码和 `DATABASE_URL` 中密码不一致。

### 16.3 容器写入 `/data` 失败

检查 SELinux：

```bash
getenforce
docker logs xihe-postgres --tail 100
```

当前目标服务器 SELinux 为 Disabled，生产 compose 未添加 `:z`。如未来启用 SELinux 后出现挂载权限问题，可考虑：

```bash
chcon -Rt svirt_sandbox_file_t /data/xihe
```

如果 PostgreSQL 在 bind mount 上 `initdb` 报 `Operation not permitted`，使用当前方案：Docker `data-root=/data/docker`，PostgreSQL 使用 Docker managed volume `xihe-postgres-data`。

### 16.4 管理员登录失败

检查：

```bash
docker compose -f docker-compose.production.yml exec api node server/bootstrap-admin.mjs
sh verify-centos7-deployment.sh
```

如果修改过 `/data/xihe/config/.env.production` 中的管理员密码，需要重新执行 `bootstrap-admin.mjs` 更新账号密码。

## 17. 回滚与停止

停止服务：

```bash
cd /data/xihe/app/prototype/infra
docker compose -f docker-compose.production.yml down
```

保留数据：

- 不删除 `/data/xihe/postgres`。
- 不删除 `/data/xihe/backups`。
- 不删除 `/data/xihe/config/.env.production`。

恢复数据库：

```bash
docker compose -f docker-compose.production.yml stop api web scheduler
sh /data/xihe/app/prototype/infra/restore-postgres.sh /data/xihe/backups/postgres/xihe_YYYYMMDD_HHMMSS.dump
docker compose -f docker-compose.production.yml up -d
```

## 18. 本阶段完成标准

满足以下条件即可认为阶段 C 服务器试运行部署完成：

- [ ] 浏览器可访问 `http://SERVER_IP:8080`。
- [ ] 管理员账号可登录。
- [ ] 可以新增人员。
- [ ] 可以查看提醒。
- [ ] 可以新增关怀记录。
- [ ] `/health` 返回正常。
- [ ] `verify-centos7-deployment.sh` 无失败项。
- [ ] 已手动完成一次 PostgreSQL 备份。
- [ ] 已配置每日备份 cron。
