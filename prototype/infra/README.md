# 羲和本地基础设施

本地 PostgreSQL 通过 Docker 运行，不要求 macOS 安装 PostgreSQL。

```bash
cd infra
docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml ps
```

连接信息：

- 地址：`127.0.0.1`
- 端口：`15432`
- 数据库：`xihe`
- 用户名和密码：读取未提交的 `.env.local`
- 持久化目录：`prototype/.local/postgres`

停止容器不会删除数据：

```bash
docker compose -f docker-compose.local.yml down
```

如需彻底重建本地数据库，必须先备份并明确删除 `.local/postgres`；日常开发不要执行该操作。

