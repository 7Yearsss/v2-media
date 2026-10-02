# R0 执行可靠性实施与验收

2026-10-02。分支 `codex/r0-execution-reliability`，基于架构复审提交 `9d88456`。范围是报告 B1/B2/B3/B6/B12，以及复查新增的发布超时/点击后结果未知。R1–R6 仍按原计划推进。

## 已实现

共享协议先加入 `browser-execution-v2`、认领/心跳/租约/收据类型和本地发布结果 `uncertain`。服务端共同模块负责能力门槛、租约匹配、收据身份锁/哈希/重放；各领域保留自己的阶段、输入和输出。

发布认领生成 10 分钟租约与递增 attempt；回采租约 2 分钟，可以过期重新认领。运行中恢复必须使用持久租约的原 claimedBy，不能因为 SW、浏览器或插件重启改变认领身份。旧插件 claim/result 无能力返回 426；旧版 running 发布无有效租约保持待核对。

收据先锁 userId/receiptId，再锁执行行；相同 ID/目标/正文返回原 ACK，换目标或正文 409。发布终态、草稿/选题更新、唯一首次 readback 与收据同事务；回采终态、指标/账号快照、后续排期与收据同事务。metrics 只接收任务指定的单篇笔记和归属来源，无 ID 的 readback 不得 verified，空快照不得成功，历史二次回采不能降级已经 verified 的证据。

插件新增 `ExecutionStore`，保存原授权 epoch/API base、租约、tab、payload 交付标记及结果 outbox；不重复保存 bearer token。启动先 reconcile 自有执行/孤儿页，再排发布和回采。已交付发布不会重新交付或重执行；只读回采可以清理过期页并重新认领。结果先持久、后 POST、同一结果复用收据，ACK 后才清理执行和页面，旧授权结果不会发给新用户。

TRUSTED_CLICK 允许当前执行 owner 的 tab；每次物理鼠标按下前重新核对授权、有效服务器租约和实时 XHS 身份，lastAccount/旧缓存不能授权发布。深采取消按稳定 noteId 移除，完成 A 不再 shift 丢掉 B。关键词验证码先持久本地停止再 finish；断网保留验证页、停止后续任务。新增 controlRevision/lastControlAction 区分明确 resume/cancel 与自动租约回收，后者不能解除安全阻断。

发布超时、丢失执行页、最终点击返回不完整或点击后结果读取失败都进入本地 uncertain，保留服务端 running 和现场，不制造可重试 failed。点击前明确失败仍可 failed；已观察成功但回传 ACK 失败，不发送第二个失败结果。当前发布列表可派生显示过期租约结果未知，GET 不因此改写任务。

## 验证方法与证据

所有测试仅使用内存 PGlite、mock AI/fetch/Chrome、假时钟和隔离 storage；未读取主目录生产 .env，未连接、迁移、写入或清理生产库，未部署/重启服务，也未向真实 XHS 发采集或发布请求。

- `test/browser-execution.test.ts`：9 项，覆盖无能力/未认领/过期/不同 attempt、并发重复收据、跨任务或领域复用、取消后迟到结果、metrics 错关联/重复行、无 ID readback、空快照和事务故障回滚。故意注入写入失败产生的 500 为预期，重试后仅一次副作用。
- `test/extension-execution.test.ts`：17 项，加载实际 background bundle。覆盖自身真实点击/他页拒绝、payload 单次交付、SW 与完整浏览器重启恢复原租约、孤儿关键词/回采页、高优先级调度、验证断网/自动过期不能解除、ACK 补报、授权切换、深采取消、过期点击与实时账号改变/不可验证、发布超时/未知结果持久停止。最初 8 项在修复前为 6 失败/2 通过；后续扩充 9 项用于复查发现的边界。
- 其中一项将实际 background 的 claim、heartbeat、result 接到真实 Hono + 内存 PGlite，服务端提交成功后故意丢失 ACK，再冷启动补报。同一个 receiptId/正文返回原 ACK，数据库只有一条收据与一个 readback，草稿已 published；没有重新开发布页或重新交付 payload。这覆盖客户端与服务端协议接缝，不能替代真实 Chrome adapter。
- `test/publish-outcome.test.ts`：3 项，验证最终点击/结果确认的不可逆边界：只有观察结果可返回成功，结果超时或不完整点击都是未知，不再次点击。
- 既有关键词控制回归补充断言：自动 expiry/reclaim 增加 revision，但保持最近人类控制字段；明确 pause/resume 会更新控制字段。

最终验收：22 个测试文件、184 项测试全部通过（单 worker，80.18 秒），全仓 typecheck、插件构建、Web 构建和 diff 检查通过。命令为 `npm run typecheck`；在 apps/server 运行 `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=1 --minWorkers=1`；`npm run build:ext`；`npm run build -w @v2media/web`；`git diff --check`。日志位于忽略目录 `data/r0-*.log`。Web 仍有既有大 bundle 警告，route lazy 属于 R4，当前没有修改前端打包结构。

## 升级及仍待完成

插件版本为 0.1.9。未来升级必须同时部署新增租约列/收据表/用户控制列、服务端协议和扩展；不能只刷新扩展继续接旧服务端。新 DDL 为追加字段/表，当前仅在内存测试运行。既有历史和生产测试痕迹未删除或合并。

未知发布保守阻断自动任务，尚无独立人工核对/解除工作流；pending cancel 仍不承诺撤销已发送动作。真实 Chrome 的 debugger、创作中心/PC 登录身份、站点 DOM、R2/真实模型/私密发布/真实回采需在 R5 用明确账号和测试范围验收。T0 生产 1 天/7 天指标到期后的证据仍需核对。

R0 集中持久记录/结果处理与协议不变量，浏览器领域调度仍由 background 协调，不宣称已完成整套协调模块重构。接下来先做 R1：用户缓存与请求上下文、草稿持久编辑/CAS、人设链路和原快照重试；R2 再补发布证据保留、账号身份唯一、运行模式与版本迁移。

架构报告和 `docs/research/probes` 保留 `ffd7c0e` 审查基线；那些探针断言旧缺陷，修复后可能失败，正式验收使用 test 中的回归。
