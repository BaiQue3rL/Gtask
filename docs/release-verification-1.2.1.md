# Gtask 1.2.1 发布验证

日期：2026-10-14，Asia/Shanghai。用户授权本轮修复后更新版本，并在全部工作完成后执行关机。本次是新的补丁版本；既有 1.2.0 标签与附件保留。

## 源码与检查

- PR：[完成判定修复与 1.2.1](https://github.com/BaiQue3rL/Gtask/pull/10)。
- 发布源码与 `v1.2.1`：`9e48ac0b598c0be50b6d8033d418b4df603ee3f0`；应用与随附插件版本均为 1.2.1，数据库保持 schema 8。
- Git 传输连接不稳定，使用已授权 GitHub CLI 的 Git 数据接口上传，并核对每个对象及原始提交 SHA；没有强制改写其他提交或既有标签。
- 498 项本地测试通过、12 项按原配置跳过；类型检查、生产构建、公共清单消费校验、安装版与便携版检查通过。安装器模板摘要恢复一致。
- [PR Verify](https://github.com/BaiQue3rL/Gtask/actions/runs/38432871193)、[主分支 Verify](https://github.com/BaiQue3rL/Gtask/actions/runs/38433853219) 与 [Release](https://github.com/BaiQue3rL/Gtask/actions/runs/38434677865) 均成功结束。

## 本机升级

`D:\Git\Gtask` 已升级并实际启动验证为 1.2.1，37 个程序文件匹配本机验收包，7 个维护运行时文件一致。同步成功显示绿色“已同步”和时间；弹球活动保持自动完成，重启验收通过。替换期间的清单、绑定、快照、保护行、设置与加密凭据核对保留，数据库完整性为 ok、schema 8，未创建部署备份。

包内清单检查为 263 个条目，没有测试、临时资料、真实数据库或凭据文件。原始回执保存在 `C:\Users\Administrator\AppData\Local\Codex\task-receipts\gtask-release-1.2.1-*.json`，本机包摘要与 CI 下载附件摘要分别记录。

## 下载附件

GitHub 三个附件已实际下载，逐项核对大小与平台 digest，两个程序同时匹配 `SHA256SUMS.txt`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `Gtask-1.2.1-setup.exe` | 92567104 | `5b236cd3b41b6c9c053207504d797d34acf665ea82d8e6c7fc721a1aa78ef589` |
| `Gtask-1.2.1-portable.exe` | 83066761 | `81f40a753596beec3d923d66c1c9330aa01751bcb4446843f7f92176abd74db8` |
| `SHA256SUMS.txt` | 181 | `56c9100a17dc3c336f401cbf3ce99b8046619bd2d869ea70579a355160750772` |

[GitHub 下载页](https://github.com/BaiQue3rL/Gtask/releases/tag/v1.2.1)。更新元数据推进至 1.2.1 的提交与在线检查另行记录，不移动发布标签。

## 镜像边界

Gitee Release `1203641` 已建立，但公开 `/attach_files` 返回空列表；流水线的 Gitee 上传步骤失败，GitHub 发布成功不受影响。安装版和便携版当前均无可验证的 Gitee 二进制链接，`updates/latest.json` 两个 provider 下载地址统一使用已验证的 GitHub 1.2.1。
