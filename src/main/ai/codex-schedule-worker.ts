import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'

export const CODEX_SCHEDULE_WORKER_AGENT_ID = 'gacha-app-background-worker'

export interface CodexCliDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  listDirectories?: (path: string) => string[]
  modifiedAt?: (path: string) => number
}

export interface CodexScheduleWorkerEvent {
  phase:
    | 'starting'
    | 'initializing'
    | 'connecting'
    | 'retrying'
    | 'fallback'
    | 'authorization'
    | 'stopped'
  message: string
  current?: number
  total?: number
  exitCode?: number | null
}

export interface CodexScheduleWorkerOptions {
  workingDirectory: string
  env?: NodeJS.ProcessEnv
  findExecutable?: () => string | null
  spawnProcess?: typeof spawn
  onEvent?: (event: CodexScheduleWorkerEvent) => void
}

export interface CodexScheduleWorkerLaunchResult {
  status: 'started' | 'already_running' | 'unavailable'
  message: string
  executablePath: string | null
}

const BACKGROUND_PROMPT = `必须使用 $sync-gacha-schedules 技能处理“幻游清单”的后台同步队列。
你是由桌面应用自动启动的本地后台 Agent，不要修改项目源码，也不要要求用户回复。
用户已经在桌面应用中主动点击同步，明确授权本轮读取公开资料并通过专用 MCP 安全合并对应清单；该授权不包含删除、凭据读取或其他版块写入。
请使用固定 Agent ID“${CODEX_SCHEDULE_WORKER_AGENT_ID}”、名称“幻游清单后台 Codex”登记联网能力。
然后连续领取并完整处理公开资料任务，严格按技能要求更新每个阶段的用户可见进度；每个已领取任务必须提交或明确失败。
公开资料队列为空后，继续处理全部待核验的语义候选，直到没有任务，再退出。`

export function findCodexCli(options: CodexCliDiscoveryOptions = {}): string | null {
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const listDirectories = options.listDirectories ?? ((path: string) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name))
  const modifiedAt = options.modifiedAt ?? ((path: string) => statSync(path).mtimeMs)
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates: string[] = []

  if (env.CODEX_CLI_PATH) candidates.push(env.CODEX_CLI_PATH)
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, executableName))
  }

  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin')
    candidates.push(join(binRoot, executableName))
    try {
      const versioned = listDirectories(binRoot)
        .map((directory) => join(binRoot, directory, executableName))
        .filter(exists)
        .sort((left, right) => modifiedAt(right) - modifiedAt(left))
      candidates.push(...versioned)
    } catch {
      // Codex Desktop is optional; PATH and the explicit override remain available.
    }
  }

  return candidates.find((candidate) => {
    try {
      return exists(candidate)
    } catch {
      return false
    }
  }) ?? null
}

export function parseCodexWorkerLine(line: string): CodexScheduleWorkerEvent | null {
  const retry = line.match(/(?:Reconnecting\.\.\.|retrying sampling request)\s*\(?(\d+)\/(\d+)/i)
  if (retry) {
    return {
      phase: 'retrying',
      message: `Codex 正在连接模型，重试 ${retry[1]}/${retry[2]}`,
      current: Number(retry[1]),
      total: Number(retry[2])
    }
  }

  try {
    const event = JSON.parse(line) as {
      type?: string
      message?: string
      item?: {
        type?: string
        message?: string
        error?: { message?: string } | null
      }
    }
    if (event.type === 'thread.started') {
      return { phase: 'initializing', message: 'Codex 已启动，正在初始化同步插件' }
    }
    if (event.type === 'turn.started') {
      return { phase: 'connecting', message: 'Codex 已连接，正在领取同步任务' }
    }
    if (
      event.type === 'item.completed' &&
      event.item?.type === 'error' &&
      /falling back/i.test(event.item.message ?? '')
    ) {
      return { phase: 'fallback', message: 'Codex 主连接超时，正在切换备用连接方式' }
    }
    if (
      event.type === 'item.completed' &&
      event.item?.type === 'mcp_tool_call' &&
      /cancelled|approval|permission/i.test(event.item.error?.message ?? '')
    ) {
      return {
        phase: 'authorization',
        message: 'Codex 同步工具授权被拒绝，本次同步无法继续'
      }
    }
  } catch {
    // Non-JSON diagnostic lines are intentionally ignored unless they expose retry counts.
  }
  return null
}

export class CodexScheduleWorker {
  private child: ChildProcess | null = null
  private stopped = false

  constructor(private readonly options: CodexScheduleWorkerOptions) {}

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.stopped)
  }

  start(): CodexScheduleWorkerLaunchResult {
    if (this.isRunning()) {
      return {
        status: 'already_running',
        message: 'Codex 自动处理进程已运行，正在等待轮到本任务',
        executablePath: this.child?.spawnfile ?? null
      }
    }

    const executablePath = (this.options.findExecutable ?? (() =>
      findCodexCli({ env: this.options.env })))()
    if (!executablePath) {
      return {
        status: 'unavailable',
        message: '未找到本机 Codex CLI；请先安装或登录 Codex 后重试',
        executablePath: null
      }
    }

    this.stopped = false
    const spawnProcess = this.options.spawnProcess ?? spawn
    const child = spawnProcess(executablePath, [
      'exec',
      '--ephemeral',
      '--json',
      '--color',
      'never',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="on-request"',
      '-c',
      'approvals_reviewer="auto_review"',
      '--skip-git-repo-check',
      '-C',
      this.options.workingDirectory,
      BACKGROUND_PROMPT
    ], {
      cwd: this.options.workingDirectory,
      env: { ...process.env, ...this.options.env, CODEX_GACHA_BACKGROUND: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.options.onEvent?.({
      phase: 'starting',
      message: '正在启动本机 Codex 自动处理进程'
    })

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let lastFailureMessage: string | null = null
    const consume = (chunk: Buffer | string, source: 'stdout' | 'stderr'): void => {
      const combined = (source === 'stdout' ? stdoutBuffer : stderrBuffer) + chunk.toString()
      const lines = combined.split(/\r?\n/)
      const remainder = lines.pop() ?? ''
      if (source === 'stdout') stdoutBuffer = remainder
      else stderrBuffer = remainder
      for (const line of lines) {
        const event = parseCodexWorkerLine(line.trim())
        if (event) {
          if (event.phase === 'authorization') lastFailureMessage = event.message
          this.options.onEvent?.(event)
        }
      }
    }
    child.stdout?.on('data', (chunk) => consume(chunk, 'stdout'))
    child.stderr?.on('data', (chunk) => consume(chunk, 'stderr'))
    child.once('error', (error) => {
      this.child = null
      this.options.onEvent?.({
        phase: 'stopped',
        message: `Codex 自动进程启动失败：${error.message}`,
        exitCode: null
      })
    })
    child.once('exit', (exitCode) => {
      this.child = null
      if (this.stopped) return
      this.options.onEvent?.({
        phase: 'stopped',
        message: exitCode === 0
          ? lastFailureMessage ?? 'Codex 自动处理进程已结束'
          : `Codex 自动处理进程异常退出（代码 ${exitCode ?? '未知'}）`,
        exitCode
      })
    })

    return {
      status: 'started',
      message: '正在启动本机 Codex 自动处理进程',
      executablePath
    }
  }

  stop(): void {
    this.stopped = true
    if (this.child && this.child.exitCode === null) this.child.kill()
    this.child = null
  }
}
