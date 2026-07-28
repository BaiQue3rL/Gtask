# Codex 代理与 WebSocket 重试排查记录

记录日期：2026-07-27（Asia/Shanghai）
性质：本机实测结论，供 Gtask 网络诊断与兼容模式设计使用

> 原始记录来自用户桌面文件 `Codex代理与WebSocket重试问题排查说明.md`。本文保留可复用的排查结论；代理端口、Codex 版本和配置路径属于本次实测环境，不能直接假定适用于所有用户。

## 一、实测现象

本机只保留 Windows 系统代理时，Codex Responses WebSocket 依次出现：

```text
1/5 → 2/5 → 3/5 → 4/5 → 5/5
```

每次约等待 15 秒。五次 WebSocket 全部超时后，Codex 输出 `falling back to HTTP`，随后 HTTP/SSE 立即连接成功。

本次日志确认的传输顺序是：

```text
wss://chatgpt.com/backend-api/codex/responses
→ 五次 WebSocket 超时
→ falling back to HTTP
→ POST https://chatgpt.com/backend-api/codex/responses
→ SSE 正常返回
```

因此，“第五次后恢复”不代表 WebSocket 成功，而是已经切换到 HTTP/SSE。

## 二、两个不同根因

### 1. 永久代理环境变量造成代理关闭后全局断网

曾将以下用户级环境变量永久指向本地代理：

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`
- `NO_PROXY`

代理软件运行时，本地端口有监听，继承环境变量的程序能够联网；代理软件退出后端口停止监听，但永久环境变量仍存在，程序继续访问失效端口，表现为大量软件无法联网。

结论：Gtask 不得通过永久设置用户级代理环境变量修复 Codex。

### 2. WebSocket 未能使用 Windows 系统代理

本机 Windows 系统代理指向本地代理端口，普通 HTTP 软件及 Codex HTTP/SSE 可以使用；Codex Responses WebSocket 却持续超时。

设置 `HTTPS_PROXY`/`ALL_PROXY` 时 WebSocket 可工作，说明 WebSocket 客户端能够读取这些环境变量，但本机组合下没有成功使用 Windows 系统代理路径。

现有证据只能确认“WebSocket 的系统代理路径在本机失效”，不能仅凭一次实测断言根因一定是 Codex、代理软件或其中某一方。

## 三、已评估方案

### 永久设置用户级代理环境变量

可以让 WebSocket 使用本地代理，但代理退出后会污染其他软件并造成断网。

结论：禁止作为 Gtask 修复方案。

### 代理软件全局/TUN 模式

在网络层覆盖 Codex 桌面端、CLI 和后台任务，不要求每个进程自行理解系统代理。

结论：可作为用户自行选择的通用方案；Gtask 只提示，不代替用户修改代理软件。

### 只向特定 Codex 进程注入代理环境变量

不污染全局系统，但所有启动入口都要经过指定启动器。

结论：可用于完全受 Gtask 控制的后台 Worker，但不是桌面 Codex 和所有 CLI 的通用修复。

### 禁用 Responses WebSocket，直接使用 HTTP/SSE

本机实测能够跳过约 90 秒重试，并继续使用 Windows 系统代理和原有 ChatGPT 登录。

通用 Codex 配置示例：

```toml
model_provider = "chatgpt-http"

[model_providers.chatgpt-http]
name = "ChatGPT HTTP"
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

本机使用独立 CLI 完成两次真实请求，约 5 秒返回，未再出现 WebSocket 重试。

结论：是本机已验证的兼容方案，但修改用户全局 `config.toml` 会影响相同 `CODEX_HOME` 下的桌面端和 CLI，必须明确告知、备份、验证并提供回滚。

## 四、Gtask 采用的产品策略

Gtask 不应把修改用户全局 Codex 配置作为默认修复。推荐顺序如下：

1. 识别真实 `1/5`～`5/5` 和 `falling back to HTTP` 日志，区分 WebSocket 重试、普通网络重试和个人接口重试。
2. 向用户说明：继续等待通常仍会回退 HTTP，但会增加约 1～2 分钟同步时间。
3. 提供“继续等待”和“本次 Gtask 同步使用 HTTP 兼容模式”。
4. HTTP 兼容模式只影响 Gtask 启动的后台 Codex Worker，通过进程级模型提供商参数禁用 WebSocket，不修改用户全局配置。
5. 同时给出非强制建议：代理软件可切换全局/TUN 模式。
6. 只有用户明确要求修复全部 Codex 入口时，才考虑修改用户 `config.toml`；修改前必须创建时间戳备份，严格校验 TOML 和 Codex 配置，修改后提示完整重启，并提供一键回滚。
7. 永远不要永久设置用户级 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 或 `NO_PROXY`。

## 五、UI 建议文案

检测到 WebSocket 连续超时后可显示：

> 检测到 Codex WebSocket 连接连续超时。Codex 通常会在重试后改用 HTTP 继续同步，但可能额外等待约 1～2 分钟。你可以继续等待、让本次 Gtask 同步改用 HTTP 兼容模式，或自行将代理软件切换为全局/TUN 模式。

选项：

- 本次改用 HTTP
- 继续等待
- 查看排查说明

不得写成“代理一定配置错误”，因为同样的重试也可能来自临时网络、服务端或代理软件兼容性问题。

## 六、诊断与验收

诊断信息至少应区分：

- `responses_websocket`：正在使用 WebSocket。
- `responses_http` / `codex_api::sse::responses`：正在使用 HTTP/SSE。
- `falling back to HTTP`：WebSocket 已失败并发生回退。

HTTP 兼容模式验收：

1. 不出现 WebSocket `1/5`～`5/5`。
2. 直接请求 Responses HTTP 端点并接收 SSE。
3. Gtask 后台 Worker 能正常领取和完成任务。
4. 不修改 Windows 系统代理、WinHTTP 或用户级代理环境变量。
5. 关闭 Gtask 后不影响桌面 Codex、浏览器或其他软件联网。

## 七、原始记录中的版本与环境

- Windows。
- 本机代理地址：`127.0.0.1:10081`。
- 更新前桌面应用：`26.707.3748.0`。
- 更新前 Codex Core：`0.144.0-alpha.4`。
- 更新后桌面应用：`26.721.4979.0`。
- 更新后独立 CLI：`0.146.0-alpha.3.1`。
- 更新后问题仍可复现，因此不能仅归因于旧版本。

这些值只用于还原本次实验，不应写死进 Gtask。
