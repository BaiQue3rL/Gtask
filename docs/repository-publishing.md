# Gtask 仓库发布素材与检索配置

本文记录首次公开发布时需要填写的仓库文案、检索关键词和视觉资产，防止 GitHub、国内镜像与后续版本说明出现不同定位。

## 发布原则

- GitHub 是唯一权威仓库；标签、提交和发布说明以 GitHub 为准。
- 当前源码版本为 `1.1.1`。公开下载与本机部署仍以实际已发布、已安装版本为准；创建 `v*` 标签和发布附件必须由用户明确要求，不能仅因推送源码自动创建 Release。
- Gitee 是免费的只读镜像和中国区默认更新入口；镜像不可用时自动回退 GitHub。
- 不购买对象存储、CDN、云服务器或付费域名，不由个人发布者承担持续流量成本。
- 软件更新默认先读取 Gitee 镜像中的小型 JSON 文件，再回退 GitHub；用户也可在设置中固定使用 Gitee 或 GitHub。网络失败时静默降级，不影响本地清单使用。
- 公共基准维护仍遵守持久基准架构；远程清单只分发已核验的 `public_schedule` 增量，不能写入个人完成状态、探索度、自定义事项或凭据。

## 镜像与发布自动化

- Gitee 仓库使用 Pull 镜像从 `BaiQue3rL/Gtask` 自动同步提交、分支和标签。
- GitHub Actions 的 `Release` 工作流仍只构建一次；GitHub Release 成功后，使用仓库 Secret `GITEE_TOKEN` 调用 Gitee OpenAPI 创建同版本 Release，并上传安装版、便携版和 `SHA256SUMS.txt`。
- GitHub 与 Gitee Release 发布均可安全重跑：已有 GitHub 附件会原名覆盖，Gitee 会更新同标签 Release 并仅替换本版本的三个同名附件。
- `updates/latest.json` 同时保存 Gitee 与 GitHub Release 地址。应用默认按 `Gitee → GitHub` 顺序检查，成功读取哪个源就打开对应的下载页。
- `GITEE_TOKEN` 只保存在 GitHub Actions 加密 Secret 中，不写入仓库、安装包、日志或用户配置。
- `updates/catalog.json` 是公共清单热更新入口。客户端启动时按用户的软件更新来源设置读取 Gitee/GitHub，自动模式同时校验两个源并以 GitHub 作为冲突时的权威结果；下载失败或内容无效时保留上一次本地基准。
- 后台 MCP 负责核验官方资料；只有通过协议、稳定键、时间窗、活动标签和两级地图检查的结果才允许写入远程清单。远程清单合并只触及系统基准，用户完成状态和探索进度在同稳定键更新时保留。

## GitHub About

```text
Windows desktop checklist for Genshin Impact, Honkai: Star Rail, Zenless Zone Zero and Wuthering Waves. Shows version schedules, events, recurring challenges, exploration progress and custom checklists.
```

## GitHub Topics

```text
desktop-app
windows
game-dashboard
game-task-manager
game-progress-tracker
game-checklist
gacha-game
genshin-impact
honkai-star-rail
zenless-zone-zero
wuthering-waves
hoyoverse
electron
vue3
typescript
sqlite
```

## 中文检索词

以下词语应自然出现在 README、版本说明和功能标题中，不应机械堆砌：

- 游戏任务管理器、游戏活动日历、版本倒计时；
- 周期挑战、地图探索度、自定义游戏清单；
- 米游社进度同步、库街区进度同步；
- 原神任务、星铁活动、绝区零清单、鸣潮进度；
- Windows 桌面工具、本地数据。

## 软件快照

| 文件 | 用途 |
| --- | --- |
| `docs/assets/snapshot-overview.webp` | 跨游戏总览 |
| `docs/assets/snapshot-custom-list.webp` | 自定义清单面板 |
| `docs/assets/snapshot-custom-editor.webp` | 新增自定义事项窗口 |
| `docs/assets/snapshot-filter-all.webp` | 显示全部事项 |
| `docs/assets/snapshot-filter-incomplete.webp` | 只看未完成 |
| `docs/assets/snapshot-settings-top.webp` | 游戏显示与启动同步设置 |
| `docs/assets/snapshot-settings-data.webp` | 凭据、本地数据与备份设置 |

截图必须来自隔离演示数据库，不包含 UID、手机号、二维码、Cookie、Token、真实备份路径或其他个人数据。仓库只使用原始软件界面快照，不叠加宣传口号、光效、功能标注或海报式排版。

## 素材边界

- 软件截图沿用当前游戏头像，用于指明兼容对象，不额外引入角色立绘、宣传海报或游戏 Logo。
- README 与发布页面注明相关素材、名称和商标归各自权利人所有。
- MIT 许可证只覆盖本项目代码和项目原创素材，不覆盖第三方游戏名称与商标。
- README 与 Release 页面保留非官方项目声明。

## 上线时填写

创建 GitHub 仓库后，由维护者统一完成：

1. 填写 About 描述和 Topics；
2. 启用 Issues，添加错误报告和功能建议模板；
3. 将 GitHub 设为唯一权威仓库；
4. 建立 GitHub → Gitee 的只读镜像；
5. Gitee 发行附件可免费使用时同步安装包；受限时只保留源码与说明镜像，不引入付费替代服务；
6. 通过 `v*` 标签触发公开仓库的标准 GitHub Actions runner，构建并发布安装版、便携版和 SHA-256 校验文件。

公开仓库使用标准 GitHub 托管 runner；工作流不使用大型付费 runner，不上传长期 Actions 临时产物。
