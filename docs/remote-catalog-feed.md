# 远程清单热更新协议

`updates/catalog.json` 用于在不发布新安装包的情况下分发已经核验的公共版本窗口、活动、周期和地图增量。GitHub 是权威源，Gitee 是免费镜像；用户设置中的“自动/Gitee/GitHub”同时适用于软件更新和清单热更新。

## 客户端行为

1. 应用启动后静默读取允许的远程源。
2. 自动模式允许 Gitee 与 GitHub 并行返回；同一修订优先使用镜像，内容冲突时以 GitHub 为准。
3. 只接受 HTTPS、1 MB 以内、`schemaVersion: 1` 且字段完全符合契约的 JSON。
4. 远程发布时间早于本机最后成功应用时间时拒绝倒退。
5. 四款游戏的全部修改在一个 SQLite 事务中合并；任一稳定键、时间窗、标签或地图父子关系无效时整批回滚。
6. 成功后只通知界面重新读取清单，不显示维护流程或弹窗；网络失败时继续使用上一次持久基准。

## 数据边界

- `upserts` 只允许 `limited_event`、`endgame` 和严格两级的 `exploration`。
- 活动必须有完整起止时间、HTTPS 来源和有效玩法标签。
- 周期必须有稳定 `modeKey`、当期 `periodKey` 和完整窗口。
- 地图只允许无父级 `region` 或恰好归属一个现有 `region` 的 `subregion`。
- `archives` 只能按稳定 `remoteKey` 删除 `public_schedule` 行。
- 协议不包含 `completed`、`progressPercent`、账号标识、Cookie、Token 或任何 `custom` 写入字段。
- 同稳定键更新标题、时间或层级时，用户完成状态、手动完成锁和探索度保持不变。

## 发布步骤

1. 使用后台 MCP 和可靠来源核验需要变更的公共事实。
2. 只添加最小 `upserts` 或明确的 `archives`，并生成新的唯一 `revision` 与实际 `publishedAt`。
3. 运行 `tests/remote-catalog-update.test.ts`、地图专项测试、完整测试、类型检查和构建。
4. 将代码与 `updates/catalog.json` 合入 GitHub 权威分支，等待 Gitee Pull 镜像；自动来源即使镜像延迟也可使用 GitHub 新内容。
5. 需要撤回测试或错误卡片时发布新修订，把对应稳定键放入各游戏的 `archives`，不能复用旧修订或依赖客户端自然覆盖。
