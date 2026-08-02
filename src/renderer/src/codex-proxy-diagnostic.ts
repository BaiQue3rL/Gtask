import type { SyncProgressUpdate } from '../../shared/contracts'

export const CODEX_PROXY_WARNING =
  'Codex 正在反复重连。常见原因包括代理、防火墙或安全网关未正确放行 WebSocket、TLS 检查提前关闭长连接，或临时网络波动；继续等待可能延长同步时间。当前版 Codex 已支持 Windows 系统代理。你可以切换全局/TUN，也可以让软件显式套用当前本地代理，仍失败时再改用 HTTPS 兼容连接。'

export const CODEX_PROXY_REPAIR_PROMPT = [
  '请帮我排查这台 Windows 电脑上的 Codex 网络连接。',
  '当前版 Codex 已原生支持 Windows 系统代理（包括 PAC/WPAD），请不要预设“系统代理本身就是故障原因”。',
  '请根据实际日志检查代理、防火墙或安全网关是否允许到 chatgpt.com:443 的 WebSocket Upgrade；同时检查 TLS/SSL 检查、长连接空闲超时和消息大小限制是否会提前中断连接。',
  '如果用户使用本地代理软件，可建议切换全局/TUN；如果继续使用系统代理，请确认 Codex 实际解析到了正确的本地代理端口。仍无法稳定使用 WebSocket 时，再考虑关闭 Responses WebSocket、改用 HTTPS 兼容传输。',
  '不要改动无关设置，不要读取或输出任何密钥。修改前说明依据，修改后分别验证普通 HTTPS 和 Codex WebSocket 连接。'
].join('')

export function isCodexConnectionRetry(progress: SyncProgressUpdate | null): boolean {
  return Boolean(
    progress &&
    progress.phase === 'retrying' &&
    progress.retryKind === 'codex_connection'
  )
}
