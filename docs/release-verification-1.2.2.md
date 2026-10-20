# Gtask 1.2.2 发布验证

日期：2026-10-20，Asia/Shanghai。用户授权修复危局同步、升级版本、推送远端、更新本机，并要求全部完成后关机。

## 修复与验证

危局强袭战旧 `/mem_detail` 成功返回空战绩；同一账号、同一期在官方当前 `/hadal_mem_detail_v2` 返回 3 条战绩和 9 星。此次仅替换取数入口并更新适配器版本；保留本期有可靠非自动记录即完成的语义，不增加满星或通关门槛，也不新增过时接口回退。

新增最小脱敏响应及客户端至数据库回归，校验实际请求地址，覆盖有记录、无记录、未知与请求失败。四游戏现场读取共 12 个周期模式；原神 3 种、星铁 4 种、鸣潮冥歌海墟的正记录正常识别。式舆、深塔、矩阵本轮没有可验证手动正记录样本，未据零结果宣称所有情形正常。结构合法的过时空响应仍需通过官方接口契约核验发现，三态保护不能自行辨认其来源是否过时。

502 项完整测试通过、12 项按原配置跳过；类型检查、生产构建、清单消费、安装版和便携版检查通过。应用与随附插件版本均为 1.2.2，数据库 schema 保持 8。

## 本机更新

`D:\Git\Gtask` 已更新至 1.2.2；37 个程序文件与本机验收包一致，7 个当前维护运行时文件核对通过。真实官方同步将危局自动标为完成，手动锁为 false，重启后保持，界面显示绿色“已同步”。

程序替换前后完整清单、个人元数据、目录、保护行、设置及加密凭据摘要一致；随后正常同步只改变个人完成状态与证据。数据库完整性 ok、schema 8，未创建部署备份。包内 263 个条目，无测试、临时资料、真实数据库或凭据。既有维护运行时中的历史松散分块不在本次接口修复范围，未扩大清理。

本机 app.asar SHA-256：`4afd8d452cd712fd671e82731eea9f9bc6605e2ac329a04cd6c1fe1161cd1e15`。本机包与 CI 构建分别记录摘要，不声称二者的压缩或时间元数据相同。

## 源码与流水线

- [PR #21](https://github.com/BaiQue3rL/Gtask/pull/21)，源提交 `dbcd383a53f4cbdbd2d24964eeee296c15ccfa56`。
- 合并提交与发布标签 `v1.2.2`：`1d51871fa970c11761440b8e006b17d5f35580a0`，GitHub/Gitee 一致。
- [PR Verify](https://github.com/BaiQue3rL/Gtask/actions/runs/39441597629)：成功。
- [主分支 Verify](https://github.com/BaiQue3rL/Gtask/actions/runs/39441943075)：第二次执行成功；首次为既有 SQLite 历史保留压力测试 15 秒超时。
- [Release](https://github.com/BaiQue3rL/Gtask/actions/runs/39441966535)：整体成功；镜像附件状态单独见下方。

## 已下载附件

[GitHub 下载页](https://github.com/BaiQue3rL/Gtask/releases/tag/v1.2.2)。三个附件均已实际下载，匹配平台 digest；两个程序同时匹配 `SHA256SUMS.txt`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `Gtask-1.2.2-setup.exe` | 92567302 | `2190898bdfd10c44f29611539f5d9dc77bb5f4f41004342487fb84a5318b403f` |
| `Gtask-1.2.2-portable.exe` | 83067078 | `1eaa817b5d5beb16605c18ee46e47b8850f9d74bd929d38cb966f345fa588a3a` |
| `SHA256SUMS.txt` | 181 | `560ac0b6456559c8c8f4eb8a15e0a2555154c93dff33373b4cc8d68f7099688f` |

## 镜像与更新入口

Gitee 源码与发布标签已同步，Release `1223569` 已建立，但 `/releases/1223569/attach_files` 返回空列表。上传日志明确出现 `fetch failed` / `UND_ERR_CONNECT_TIMEOUT`，回退步骤也执行；尽管平台对启用 continue-on-error 的步骤返回绿色 conclusion，不能据此声称 Gitee 二进制上传成功。

`updates/latest.json` 的两个 provider 下载页均指向已验证的 GitHub 1.2.2。元数据提交和在线更新检测在后续回执记录，不移动发布标签。

原始本机更新、重启验收、远端资产、源码和流水线记录保存在 `C:\Users\Administrator\AppData\Local\Codex\task-receipts\gtask-release-1.2.2`。最终关机以同目录最终回执为准，不能把本段授权沿用到下一轮。
