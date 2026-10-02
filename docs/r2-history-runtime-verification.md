# R2 历史保留、身份与运行模式验收

2026-10-02（北京时间）。分支 `codex/r2-history-runtime`，基于 R1 `a789d6c`。实现架构报告 B5/B11，以及明确只读运行、版本迁移和并发升级验证。生产未连接、迁移、写入、部署、重启或清理测试痕迹。

## 已实现

账号解绑和草稿删除改为幂等软归档，`archivedAt` 单独表达历史生命周期。默认活跃列表隐藏归档，`includeArchived=1` 可读，显式 restore 恢复原 ID。工作台有“包含已解绑账号”“包含归档草稿”和恢复入口，旧草稿链接仍可读取归档内容。归档前先保存本地编辑，保存失败或版本冲突时不丢掉编辑继续归档。

原文、人设、账号身份、发布尝试、指标、账号趋势、复盘与 ready 素材不删除。pending 发布/新账号快照取消；运行中发布保留现场与历史回执，下一次真实点击续租被归档状态拦住。归档撤销未完成生成/上传/封面代次，归档后立即恢复也不能让先前模型/素材结果复活；恢复不自动重新排任务。六条证据外键改 RESTRICT，媒体 GC 继续保留归档草稿与发布快照引用。

心跳按 user/platform/subType/xhsUserId 原子 UPSERT，仅更新观测字段，保留人设/归档状态。并发、批量及账号快照排期同事务，空白/不规范/批内重复 ID 拒绝。pc 与 creator、不同用户保持独立身份。旧重复、空白或非规范身份阻塞升级，检测只报告 ID，不自动归并、删行或重分配关联。

生产启动不再重放全量 DDL。冻结旧 bootstrap 为版本 1，版本 2 追加归档、唯一身份与历史外键；迁移账本包含版本/名称/校验和，LF/CRLF 统一后计算。后续结构追加版本，不改已发布 migration。事务包含 DDL、首次账号回填和账本；并发迁移使用事务 advisory lock，默认等待 10s、语句 120s，异常整体回滚。启动只检查账本/校验和、实际列、唯一索引及六条外键，不通过则拒绝服务。

## 运行与升级配置

| 模式 | 数据与权限 | 写入和后台行为 |
|---|---|---|
| local-isolated（默认） | 本地 PGlite；出现 DATABASE_URL 即拒绝 | 本地开发可写；真实 R2 必须声明匹配的 LOCAL_R2_BUCKET，禁止生产 v2-media 桶 |
| production-readonly | 显式 PG URL、至少 32 字符 AUTH_SECRET、专用只读角色与只读连接 | 写 API 403，仅无入库登录和读取允许；worker/上传/AI/媒体维护低层入口停止 |
| production-worker | 显式 PG URL、有效 AUTH_SECRET、64 hex 的 ENCRYPTION_KEY | 允许业务执行；只检查 schema，迁移单独运行 |

保留既有有效生产密钥，不能为满足长度校验随意替换而使登录或加密数据失效。只读角色应仅有业务读取权限；角色命名或 `default_transaction_read_only=on` 本身不足以证明权限。检查包含可达角色（含 NOINHERIT）、数据库/schema/关系所有权和写/CREATE、列写、sequence 及可执行应用 SECURITY DEFINER 权限；schema 排除只匹配字面 `pg_` 前缀，不能把 `pgx_*` 用户 schema 漏掉。依据 PostgreSQL 的 [权限查询](https://www.postgresql.org/docs/current/functions-info.html)、[SET ROLE](https://www.postgresql.org/docs/current/sql-set-role.html) 与 [只读事务](https://www.postgresql.org/docs/current/sql-set-transaction.html)。最低 PG14，实际独立连接探针使用 PG16.15。

只读服务 GET 不因观察写入：账号 stale 与超时分析派生显示，回采候选 GET 不回收租约，POST claim 才原子替换过期可重做任务。`/api/runtime` 经普通 API 代理给工作台只读提示，`/health` 同样返回模式与版本。持久业务数据只读，不把 PostgreSQL 允许的临时会话操作等同于业务写入。

使用正确模式和角色后，仓库根目录四个显式命令为：

```sh
npm run db:status -w @v2media/server
npm run db:duplicates -w @v2media/server
npm run db:check -w @v2media/server
npm run db:migrate -w @v2media/server
```

status/duplicates/check 不升级；readonly 模式拒绝 migrate。worker 迁移可用 `MIGRATION_DATABASE_URL` 指定独立 DDL 角色；服务继续使用自己的 DATABASE_URL。CI 已加入显式迁移再重启步骤，但尚未触发部署。部署前必须配置运行模式/密钥/角色、备份并在实际脱敏副本验证，旧身份异常需先人工审查；本次没有对生产自动修复。

## 自动回归与实际 PostgreSQL

新增三组内存回归：历史 7 项、身份 9 项、runtime/migrations 12 项，共 28 项。范围包括归档/恢复、跨用户、原文与指标/趋势/复盘/媒体保留、物理误删拒绝、模型与 PUT 期间归档不复活；并发 12 次心跳只生成一个身份/快照；只读 API/GET/低层 worker、有效角色及列写/角色切换/函数/schema 所有权拒绝、版本账本/真实结构/复制旧库/校验和/整体回滚。

保留原测试不放宽断言：人设 fixture 按真实 xhsUserId 找账号，不依赖并发锁排序造成的首次 ID 顺序；R1 解绑源用例改为归档 409，并明确断言原账号仍存在。首轮组合测试发现 Drizzle 左连接会把首列 nullable 的嵌套账号误判为空，已把主键放在 archivedAt 前，回归核对了正确账号 ID 和发布目标。

实际 PostgreSQL 探针从 Ubuntu 官方包下载/解压 17.1MB 到忽略目录，没有安装系统包或改公共服务。WSL 中创建两次任务专用 ext4 临时集群，绑定 loopback 55437；最终集群与进程已停止、核验路径后清理，诊断保留。最终五个场景均通过：

1. 两个不同 PG 后台 PID 4566/4567 竞争迁移锁；100ms 上限在 112ms 返回 `55P03`，账本、DDL 和业务行均不变。释放锁后版本 2 升级和物理 schema 检查通过。
2. 旧库重复身份 ID 1/2 升级被预检阻止，两份人设、原文、发布和指标保留，账本仍仅版本 1。
3. 后续 DDL 故障 `42883` 后新增列、账本及业务全部回滚。
4. 专用只读角色校验通过；session 只读拒写 `25006`，即使关闭该开关仍因角色权限拒写 `42501`，加列 UPDATE 后启动校验拒绝。
5. 角色拥有 `pgx_probe_*` 用户 schema 时拒绝。旧通配符实现曾在真实 PG 上漏检，记录了红色结果，修复精确前缀后通过。

可复跑脚本 `apps/server/scripts/verify-postgres-migrations.ts` 仅接受显式 connection-file 和 --disposable，严格限制 host/port/database/user、禁止连接参数覆盖，不读取 DATABASE_URL 或 .env；只在自有一次性库创建测试 schema，不碰业务库。最终日志 `data/r2-pg-probe/results-final.log` 与停止状态 `status.json`；这些忽略目录诊断未提交。connection-file 应为 `{ "url": "postgres://<disposable credentials>@127.0.0.1:55437/v2media_r2_probe" }`，用户名也须 v2media_r2_probe；不能复用生产连接。

最终全仓 30 个测试文件、245 项全部通过（单 worker，123.04 秒）；全仓 typecheck、Web/插件构建及 diff 检查通过。CI 也使用单 worker，避免内存 PostgreSQL 实例并行抢资源。Web 仍有既有大 bundle 警告，路由拆分属 R4。日志 `data/r2-*.log`；测试与预览均不加载主目录生产 .env。

## 工作台验收与边界

Chrome 在内存 Hono 3602/Vite 5182 以 `r2-history@preview.invalid` 合成账号运行，顶部明确标记非生产，无 worker、真实发布、真实 R2/模型。已验证解绑后可恢复，单篇原文及 12/4/2/1 合成指标仍可看；草稿归档后显示只读原文/图集与恢复入口；同 ID 恢复；只读模式显示横幅并禁用账号编辑/解绑/插件授权，历史页面仍可读。

截图 `data/r2-archive-preview.png`、`data/r2-readonly-history-preview.png`。这证明工作台与本地 DB/角色模型，不能代替生产配置和实际 XHS 联测。T0 1 天/7 天到期数据仍待复核，R5 仍需真实账号/R2/模型/私密发布/有限采集验收。未推送 main 或部署。下一步 R3 为持久 AI run 与迟到结果 fencing，R4 工作区整合及 R6 扩样仍未实施。
