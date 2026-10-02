# 生产部署记录 · 2026-10-03

用户授权配置 GitHub Action 的生产变量并部署 main。部署提交 `a4f3b9e` 包含 main 上的 T1–T5、R0–R4 和简洁文案/圆角 UI 调整；[Action #37035987026](https://github.com/7Yearsss/v2-media/actions/runs/37035987026) 已成功。

## 配置

- GitHub Repository variable：`V2MEDIA_RUNTIME_MODE=production-worker`。部署工作流先校验变量，再写入服务器 `apps/server/.env`；仅 main 可部署。变量仅作用于部署步骤，不传给离线测试。
- 原有四项 SSH secrets 已配置且此次 Action 实际使用成功，没有替换密钥。
- 服务器原有数据库、鉴权、加密、模型和 R2 配置保持原样；`.env` 权限为 `0600`。
- 首次升级保留 `DISABLE_MEDIA_MAINTENANCE=1`，关闭自动媒体维护/清理，保护旧素材。上传、封面和 AI 作业仍可运行。是否恢复维护需结合旧媒体保留情况另行决定。

## 部署与核对

1. 部署前保存生产数据库 dump、原代码和环境文件至服务器私有目录 `/home/ubuntu/backups/v2-media/20261003-config`。没有下载或提交凭据。
2. 在独立数据库恢复备份并脱敏，以当前代码实际执行迁移和版本检查。迁移到 schema 3 后，原表记录数量和 ID 摘要保持一致。此临时副本和探针代码已移除，生产备份保留。
3. Action 完成依赖安装、全仓 typecheck、272 项既有 server 测试、web/插件打包、同步代码、显式迁移和服务重启；未增加单测。
4. 线上 `/health` 返回 `ok=true`、`runtimeMode=production-worker`、`schemaVersion=3`；数据库版本检查无 pending migration，服务 active。
5. 首页返回 200，资源为 `index-DJidqsQH.js` / `index-DRTw69q3.css`；站内插件下载包版本为 `0.1.9`。

| 核对项 | 部署前后结果 |
|---|---|
| 用户 / 账号 / 采集笔记 | 1 / 1 / 27，数量未变 |
| 草稿 / 发布 / 指标 / 任务 | 3 / 13 / 1 / 47，数量未变 |
| 原有草稿 | 标题、正文、标签、图片、状态及关联字段的摘要一致 |
| 发布 #13 | 关键字段摘要一致；done / private / verified，note ID 存在 |
| 生产测试痕迹 | 没有删除或归并 |

## 验收边界

本次确认配置、迁移、部署和旧数据保留；真实 AI/R2/新版插件的联合验收仍按 R5 执行。没有新建生产草稿、发笔记或修改 admin@devin.local（ID #2）的人设。T0 的 1 天/7 天指标仍按原到期时间核对，不提前声称完成。

后续 main push 会自动部署；`[skip ci]` 的文档提交不会触发 push 部署。本次实际部署来源为 `a4f3b9e`。
