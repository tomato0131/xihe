# 羲和 CentOS 7.9 部署补充说明

> 适用环境：用户提供的虚拟机为 CentOS 7.9，应用、数据、备份统一放在 `/data` 目录下。

## 1. 重要结论

CentOS 7.9 可以作为羲和阶段 C 的内网试运行环境，但它已经属于老系统路线，部署时要按“兼容部署”处理：

- 使用 `yum`、`systemd`、`firewalld`、SELinux 的 CentOS 7 运维习惯。
- 优先确认服务器是否已经安装 Docker 和 Docker Compose v2。
- PostgreSQL 不开放公网端口。
- Web 测试端口先用 `8080/tcp`。
- 所有持久化数据仍然放在 `/data` 下；Docker 数据根目录建议使用 `/data/docker`。

需要注意：Docker 官方当前 CentOS Engine 安装文档列出的维护版本是 CentOS Stream 9/10；CentOS 7.9 不在当前维护列表内。因此，若服务器已有可用 Docker，优先复用现有 Docker；若没有，需要按兼容方式安装并接受后续维护风险。

参考：

- [Docker Engine CentOS 安装页](https://docs.docker.com/engine/install/centos/)列出当前维护的 CentOS Stream 版本，并说明推荐通过 Docker 仓库安装。
- [Docker Compose Linux 安装页](https://docs.docker.com/compose/install/linux/)对 RPM 系发行版仍给出 `yum install docker-compose-plugin` 和 `docker compose version` 的验证方式。

## 2. 部署前预检

先在本地查看同步计划；这一步不会连接服务器：

```bash
cd /Users/tyrion/Documents/员工关怀-生日提醒/prototype/infra
sh sync-to-centos7-vm.sh
```

如需连接服务器但不上传，执行：

```bash
sh sync-to-centos7-vm.sh --dry-run
```

确认无误后再上传：

```bash
sh sync-to-centos7-vm.sh --apply
```

把应用文件同步到服务器后，先执行：

```bash
cd /data/xihe/app/prototype/infra
sh centos7-preflight.sh
```

重点看这些结果：

- `/etc/centos-release` 是否显示 CentOS Linux release 7.9。
- `/data` 是否有足够磁盘空间。
- `docker version` 是否可用。
- `docker compose version` 是否可用。
- `systemctl is-active docker` 是否为 `active`。
- `firewalld` 是否开启。
- SELinux 是否为 `Enforcing`。

## 3. Docker / Compose 检查

优先使用 Docker Compose v2：

```bash
docker compose version
```

如果只有旧命令：

```bash
docker-compose version
```

则建议升级或安装 Compose v2 插件。羲和的部署命令默认使用：

```bash
docker compose -f docker-compose.production.yml up -d --build
```

如果服务器暂时只能使用旧版 `docker-compose`，可以临时替换为：

```bash
docker-compose -f docker-compose.production.yml up -d --build
```

但这只是兼容方案，不作为长期推荐。

## 4. CentOS 7.9 常用系统命令

检查系统版本：

```bash
cat /etc/centos-release
uname -r
```

检查 Docker 服务：

```bash
systemctl status docker
systemctl enable docker
systemctl start docker
```

检查端口监听：

```bash
ss -lntp
```

检查日志：

```bash
journalctl -u docker --no-pager -n 100
docker logs xihe-api --tail 100
docker logs xihe-postgres --tail 100
```

## 5. firewalld 端口策略

内网试运行阶段，只需要开放 Web 测试端口：

```bash
firewall-cmd --permanent --add-port=8080/tcp
firewall-cmd --reload
firewall-cmd --list-ports
```

不建议开放：

- `5432/tcp` PostgreSQL
- `8787/tcp` API 容器内部端口

如果未来启用正式域名和 HTTPS，再开放：

```bash
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

## 6. SELinux 注意事项

CentOS 7.9 如果 SELinux 为 `Enforcing`，Docker 挂载 `/data/xihe` 下的目录时可能遇到权限问题。当前目标服务器 SELinux 为 `Disabled`，生产 Compose 不使用 `:z` 标记，以避免在该环境下触发异常。

检查 SELinux：

```bash
getenforce
```

如果容器启动后出现权限问题，优先看日志：

```bash
docker logs xihe-postgres --tail 100
docker logs xihe-api --tail 100
```

可选处理方式：

```bash
chcon -Rt svirt_sandbox_file_t /data/xihe
```

如果系统安装了 `semanage`，也可以用持久化规则：

```bash
yum install -y policycoreutils-python
semanage fcontext -a -t svirt_sandbox_file_t '/data/xihe(/.*)?'
restorecon -Rv /data/xihe
```

不建议为了省事直接关闭 SELinux。真遇到阻塞时，可以先记录报错，再决定是否临时调整策略。

## 7. CentOS 7.9 首次部署顺序

推荐先使用部署脚本演练：

```bash
cd /data/xihe/app/prototype/infra
sh deploy-centos7.sh
```

确认 `/data/xihe/config/.env.production` 已填写真实配置后，再执行：

```bash
sh deploy-centos7.sh --apply
```

如果希望脚本自动开放 `8080/tcp`：

```bash
XIHE_OPEN_FIREWALL=1 sh deploy-centos7.sh --apply
```

也可以手动逐步执行：

```bash
cd /data/xihe/app/prototype/infra
sh centos7-preflight.sh
sh init-server-dirs.sh
sh create-production-env.sh
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml exec api node server/bootstrap-admin.mjs
sh verify-centos7-deployment.sh
```

然后访问：

```text
http://服务器IP:8080
```

## 8. CentOS 7.9 部署风险

| 风险 | 影响 | 处理 |
|---|---|---|
| CentOS 7.9 系统较老 | Docker 官方当前维护列表不再覆盖该版本 | 优先复用已验证 Docker；后续考虑迁移到 Rocky/Alma/RHEL 9 |
| SELinux 拦截挂载目录 | PostgreSQL 或 API 写入失败 | 当前服务器 SELinux 为 Disabled；如未来启用 SELinux，再评估是否添加 `:z` 或修正目录标签 |
| firewalld 未开放 8080 | 本机服务正常但外部访问不到 | 开放 `8080/tcp` 或改用 80/443 |
| 只有旧版 docker-compose | 部分 Compose v2 语法可能不兼容 | 优先安装 Compose v2 插件 |
| `/data` 空间不足 | 数据库和备份增长后失败 | 部署前检查 `df -h /data`，定期清理旧备份 |
| PostgreSQL bind mount 初始化失败 | `initdb` 报 `Operation not permitted` | 使用 Docker managed volume，并将 Docker `data-root` 迁到 `/data/docker` |
| PostgreSQL alpine 镜像初始化失败 | CentOS 7.9 / 3.10 内核下 `postgres:*‑alpine` 报 `Operation not permitted` | 生产环境使用 `postgres:16` 非 alpine 镜像 |
