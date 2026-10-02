# 2026-10-02 架构审查的离线探针

从仓库根目录、安装已有依赖后运行：

```powershell
node node_modules/tsx/dist/cli.mjs docs/research/probes/server-state-probe.mts
node docs/research/probes/browser-execution-probe.mjs
```

两者都不读取 .env、不启动 index/createDb、不连接生产或真实小红书。server 使用 makeApp 的内存 PGlite 与 mock AI；browser 打包当前 background 到假 Chrome/fetch 的 VM，另在内存加载 KeywordRunner。结果仅输出终态/计数/假数据，browser JSON 写在 Git 忽略目录 data。

这些是审查基线 `ffd7c0e` 的诊断，不是正式 CI 验收。server 输出用于观察缺陷；browser 断言当前错误行为，因此修复后应修改为期望正确行为的正式回归，不能将它仍然成功称为修复通过。探针源码不修补业务文件。

说明与代码位置见上级 architecture-ux-review-2026-10-02.md。今后领域契约改变时需同步更新探针，不能把固定 fixture 当真实站点契约。
