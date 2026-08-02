# 下一次开发接续点

更新时间：2026-08-02（Asia/Shanghai）

## 当前基线

- 产品版本：Gtask 1.0.0。
- 数据库使用单一 v1 首发 schema；封闭测试期旧迁移和逐条语义审核链已删除。
- 公开数据与个人数据严格隔离，完整架构见 [sync-architecture-redesign.md](./sync-architecture-redesign.md)。
- 个人快照先机械建立；只有异常字段进入 `personal_review`，标签和缺失时间进入 `personal_metadata`。
- Codex 后台固定六个执行槽，默认 `gpt-5.6-sol / medium`，用户设置从下一个任务起生效。
- 地图只允许 `region/subregion` 两级结构；维护入口见 [ai-map-catalog-maintenance.md](./ai-map-catalog-maintenance.md)。
- 系统同步清单由同步快照维护，不提供用户删除入口；回收站只保留手动事项。
- 更新源通过可扩展 Provider 接入；1.0 发布前 URL 为空，空配置不发网络请求。

## 继续开发前

1. 先阅读仓库根目录 `AGENTS.md` 和 `docs/sync-architecture-redesign.md`。
2. 保留用户未提交改动，不恢复公开/个人融合，也不恢复已删除的逐条语义审核 MCP 工具。
3. 数据结构变更必须从 1.0 首发基线新增迁移，不能复制封闭测试期历史迁移。
4. 常规验证依次运行 `pnpm test`、`pnpm typecheck`、`pnpm build`。

## 发布后人工验收

- 从安装器完成首次安装、插件引导与平台登录。
- 分别验证公开数据、个人数据首次建表、二次快路径、取消和来源切换。
- 验证应用关闭后 Gtask、MCP Node 和 Codex Worker 均不残留。
- 观察真实账号活动完成语义、官方接口改版及代理/WebSocket 环境差异。
