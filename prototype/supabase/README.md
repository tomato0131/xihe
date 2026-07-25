# 羲和数据库迁移

当前迁移包含人物、生日、分组、提醒任务与关怀记录，并对所有面向客户端的表启用 RLS。

本地阶段只保存占位配置，禁止提交真实 `.env`、数据库密码或 `service_role` key。

部署顺序：

1. 创建 Supabase/PostgreSQL 开发环境。
2. 执行 `migrations/202607060001_initial_schema.sql`。
3. 使用两个测试账号验证互相不可见。
4. 在浏览器端仅配置项目 URL 与公开 anon key。
5. 后台任务所需 service role 只存储于服务器秘密管理中。

