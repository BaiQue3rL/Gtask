# Gtask 1.2.0 发布验证

本文保留 18:42 首次发布的历史证据。用户随后明确要求地图修正仍以 1.2.0 覆盖本机并重新发布，授权替换该标签和附件；当前状态见 `release-verification-map-summary-1.2.0.md`，不能将本文旧摘要作为最新下载校验值。

日期：2026-09-15，Asia/Shanghai。用户已完成本机人工验收，并明确授权提交、推送、按行业规则递增版本和清理本机旧版本。

## 版本与源码

- 从 1.1.1 升至 1.2.0：本轮包含兼容的公共清单 v2、排期例外、维护编译器等新增能力，因此递增次版本。
- 首次发布源码：`54249d72277457a5bf64f47e688efc3d6d136f25`；当时已推送 `main` 和标签 `v1.2.0`。后续同版本替换是维护者明确授权的例外，普通修复仍不允许自动移动发布标签。
- `package.json`、仓库内置插件及安装程序版本一致；在线更新元数据在附件实际验证后单独推进，元数据提交不移动版本标签。
- [GitHub Release](https://github.com/BaiQue3rL/Gtask/releases/tag/v1.2.0) 已公开，包含安装版、便携版和校验文件。

## 验证证据

- 本地完整测试：445 项通过、12 项跳过；生产构建（含类型检查）、`catalog:check` 和暂存差异检查通过。
- [Verify 34959341343](https://github.com/BaiQue3rL/Gtask/actions/runs/34959341343) 已成功。
- [Release 34959341588](https://github.com/BaiQue3rL/Gtask/actions/runs/34959341588) 的测试、两种打包、包校验、公共清单检查、校验文件和 GitHub 发布步骤通过；附加 Gitee 镜像步骤结果以运行页为准。
- 18:48 已从公开 GitHub Release 实际下载以下三个文件，文件大小与 GitHub 资产信息一致，SHA-256 同时匹配远端资产 digest 与校验文件。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `Gtask-1.2.0-setup.exe` | 92556338 | `2b99f528b37fddf6a92400768d5d9c34d1f26609d4141146efc59ec13e8deb6d` |
| `Gtask-1.2.0-portable.exe` | 83062699 | `ec014509c949ae6043ade645c0928c5f4b5d337eb57aad4e488d07c96d5bbef0` |
| `SHA256SUMS.txt` | 181 | `2d0dce9b8413c6c47003612df2f4e275e206f7e13c4d65a721e70289ec3f60e6` |

Gitee 同版本 Release 已创建；18:48 检查附件 API 仍为空。更新元数据的两个下载入口均指向上述已验证的 GitHub Release，不能以镜像源码、标签或发行页存在作为附件可用证明。

## 本机部署与旧包清理

- 18:42 将同一发布源码构建的 1.2.0 部署至 `D:\Git\Gtask`，35 个程序文件核对通过，启动正常。该本地构建与 CI 下载资产分别校验，不混用两者的摘要。
- 本机 app.asar SHA-256：`574a50cf25a6ddd39434d41b7b6964adbd2de7d36ccf8709a63223650c703185`。
- 隔离打包地图回归在 540×720、750×1000 两种窗口下通过，无页面错误；保留截图与结果。正式数据库完整性为 `ok`，schema 8；自定义数据和加密凭据与升级前备份核对保留。
- 最新数据备份：`D:\Git\Gtask-backups\20260915-184227-pre-1.2.0`。18:13、18:26 的数据库及凭据备份也保留；部署回执仍在各备份目录。
- 18:44 按用户要求，将旧 `release/`、6 处旧打包/审计目录及三个部署备份的旧 `program` 目录移入 Windows 回收站，共 10 处、3,658,051,368 字节（约 3.41 GiB）。验证原路径均已不存在；不将移入回收站描述为磁盘空间已释放。
- 保留当前 1.2.0 程序、下载资产、个人数据库、凭据、数据备份、审计记录和研究资料；没有清空回收站。已安装 Codex 插件缓存不属于旧 Gtask 程序清理范围。

本地详细证据（忽略文件，不提交个人数据）：`tmp/release-1.2.0-asset-verification.json`、`tmp/old-version-cleanup-manifest.json`、`tmp/old-version-cleanup-result.json` 及部署备份中的 `deployment.json`。
