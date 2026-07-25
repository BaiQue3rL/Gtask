import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'

export const CODEX_SCHEDULE_WORKER_AGENT_ID = 'gacha-app-background-worker'
export const MAX_CODEX_SCHEDULE_WORKERS = 4

export function codexScheduleWorkerAgentId(slot: number): string {
  if (!Number.isInteger(slot) || slot < 1) throw new Error('Codex Worker 槽位必须是正整数')
  return `${CODEX_SCHEDULE_WORKER_AGENT_ID}-${slot}`
}

export interface CodexCliDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  listDirectories?: (path: string) => string[]
  modifiedAt?: (path: string) => number
}

export interface CodexScheduleWorkerEvent {
  agentId: string
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

export type CodexScheduleWorkerDiagnosticEvent = Omit<CodexScheduleWorkerEvent, 'agentId'>

export interface CodexScheduleWorkerOptions {
  workingDirectory: string
  agentId?: string
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

export interface CodexScheduleWorkerPoolLaunchResult {
  status: 'started' | 'already_running' | 'unavailable'
  message: string
  started: number
  running: number
}

export interface CodexScheduleWorkerPoolOptions
  extends Omit<CodexScheduleWorkerOptions, 'agentId'> {
  maxWorkers?: number
}

function backgroundPrompt(agentId: string): string {
  return `必须使用 $sync-gacha-schedules 技能处理“幻游清单”的后台同步队列。
你是由桌面应用自动启动的本地后台 Agent，不要修改项目源码，也不要要求用户回复。
用户已经在桌面应用中主动点击同步，明确授权本轮读取公开资料并通过专用 MCP 安全合并对应清单；该授权不包含删除、凭据读取或其他版块写入。
请使用固定 Agent ID“${agentId}”、名称“幻游清单后台 Codex”登记联网能力。
只领取一项公开资料任务并完整处理，严格按技能要求更新每个阶段的用户可见进度；已领取任务必须提交或明确失败。
若 target=all，某一版块资料不足时提交其他已核验版块，由应用记录为部分完成；不得因为单一版块或单一来源失败而放弃全部结果。
本 Worker 的失败只允许结束自己领取的任务，不得领取、失败或结束其他 Worker 的任务。
完成该任务后处理当前可领取的待核验语义候选，随后退出；不要继续领取第二项公开资料任务。`
}

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

export function parseCodexWorkerLine(line: string): CodexScheduleWorkerDiagnosticEvent | null {
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

  get agentId(): string {
    return this.options.agentId ?? CODEX_SCHEDULE_WORKER_AGENT_ID
  }

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
      backgroundPrompt(this.agentId)
    ], {
      cwd: this.options.workingDirectory,
      env: { ...process.env, ...this.options.env, CODEX_GACHA_BACKGROUND: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.options.onEvent?.({
      agentId: this.agentId,
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
          this.options.onEvent?.({ ...event, agentId: this.agentId })
        }
      }
    }
    child.stdout?.on('data', (chunk) => consume(chunk, 'stdout'))
    child.stderr?.on('data', (chunk) => consume(chunk, 'stderr'))
    child.once('error', (error) => {
      this.child = null
      this.options.onEvent?.({
        agentId: this.agentId,
        phase: 'stopped',
        message: `Codex 自动进程启动失败：${error.message}`,
        exitCode: null
      })
    })
    child.once('exit', (exitCode) => {
      this.child = null
      if (this.stopped) return
      this.options.onEvent?.({
        agentId: this.agentId,
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

export class CodexScheduleWorkerPool {
  private readonly workers: CodexScheduleWorker[]

  constructor(private readonly options: CodexScheduleWorkerPoolOptions) {
    const maxWorkers = options.maxWorkers ?? MAX_CODEX_SCHEDULE_WORKERS
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
      throw new Error('Codex Worker 并发数必须是正整数')
    }
    this.workers = Array.from({ length: maxWorkers }, (_, index) =>
      new CodexScheduleWorker({
        ...options,
        agentId: codexScheduleWorkerAgentId(index + 1)
      })
    )
  }

  get agentIds(): string[] {
    return this.workers.map((worker) => worker.agentId)
  }

  get runningCount(): number {
    return this.workers.filter((worker) => worker.isRunning()).length
  }

  ensureCapacity(desiredWorkers: number): CodexScheduleWorkerPoolLaunchResult {
    const desired = Math.max(0, Math.min(Math.floor(desiredWorkers), this.workers.length))
    let started = 0
    let unavailableMessage: string | null = null
    for (const worker of this.workers) {
      if (this.runningCount >= desired) break
      if (worker.isRunning()) continue
      const launch = worker.start()
      if (launch.status === 'started') started += 1
      if (launch.status === 'unavailable') {
        unavailableMessage = launch.message
        break
      }
    }
    const running = this.runningCount
    if (unavailableMessage && running === 0) {
      return {
        status: 'unavailable',
        message: unavailableMessage,
        started,
        running
      }
    }
    if (started > 0) {
      return {
        status: 'started',
        message: `正在启动 Codex 并行处理进程（${running}/${this.workers.length}）`,
        started,
        running
      }
    }
    return {
      status: 'already_running',
      message: running > 1
        ? `${running} 个 Codex 并行处理进程已运行，正在领取任务`
        : 'Codex 自动处理进程已运行，正在领取任务',
      started,
      running
    }
  }

  stop(): void {
    for (const worker of this.workers) worker.stop()
  }
}
