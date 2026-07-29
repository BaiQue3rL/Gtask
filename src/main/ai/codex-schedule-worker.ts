import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'

export const CODEX_SCHEDULE_WORKER_AGENT_ID = 'gacha-app-background-worker'
export const MIN_CODEX_SCHEDULE_WORKERS = 2
export const MAX_CODEX_SCHEDULE_WORKERS = 6
export const MAX_CODEX_SEMANTIC_REVIEW_WORKERS = 2
export const CODEX_CONCURRENCY_COOLDOWN_MS = 2 * 60 * 1000
export const CODEX_STABLE_COMPLETIONS_TO_SCALE_UP = 2

export function desiredCodexWorkerCount(
  activePublicJobs: number,
  activeSemanticReviews: number,
  maxWorkers = MAX_CODEX_SCHEDULE_WORKERS
): number {
  const capacity = Math.max(0, Math.floor(maxWorkers))
  const publicJobs = Math.max(0, Math.floor(activePublicJobs))
  const semanticReviews = Math.max(0, Math.floor(activeSemanticReviews))
  if (capacity === 0 || publicJobs + semanticReviews === 0) return 0
  if (publicJobs === 0) {
    return Math.min(semanticReviews, MAX_CODEX_SEMANTIC_REVIEW_WORKERS, capacity)
  }
  if (semanticReviews === 0) return Math.min(publicJobs, capacity)
  const reviewWorkers = Math.min(
    semanticReviews,
    MAX_CODEX_SEMANTIC_REVIEW_WORKERS,
    Math.max(1, capacity - 1)
  )
  const publicWorkers = Math.min(publicJobs, Math.max(0, capacity - reviewWorkers))
  return publicWorkers + reviewWorkers
}

export interface CodexDynamicConcurrencyOptions {
  minWorkers?: number
  maxWorkers?: number
  stableCompletionsToScaleUp?: number
  cooldownMs?: number
}

export class CodexDynamicConcurrencyController {
  private limit: number
  private stableCompletions = 0
  private cooldownUntil = 0
  private readonly minWorkers: number
  private readonly maxWorkers: number
  private readonly stableCompletionsToScaleUp: number
  private readonly cooldownMs: number

  constructor(options: CodexDynamicConcurrencyOptions = {}) {
    this.minWorkers = Math.max(
      1,
      Math.floor(options.minWorkers ?? MIN_CODEX_SCHEDULE_WORKERS)
    )
    this.maxWorkers = Math.max(
      this.minWorkers,
      Math.floor(options.maxWorkers ?? MAX_CODEX_SCHEDULE_WORKERS)
    )
    this.stableCompletionsToScaleUp = Math.max(
      1,
      Math.floor(
        options.stableCompletionsToScaleUp ?? CODEX_STABLE_COMPLETIONS_TO_SCALE_UP
      )
    )
    this.cooldownMs = Math.max(1_000, Math.floor(
      options.cooldownMs ?? CODEX_CONCURRENCY_COOLDOWN_MS
    ))
    this.limit = this.minWorkers
  }

  get currentLimit(): number {
    return this.limit
  }

  get maximumLimit(): number {
    return this.maxWorkers
  }

  recordHealthyCompletion(hasBacklog: boolean, reference = Date.now()): number {
    if (!hasBacklog || reference < this.cooldownUntil || this.limit >= this.maxWorkers) {
      if (!hasBacklog) this.stableCompletions = 0
      return this.limit
    }
    this.stableCompletions += 1
    if (this.stableCompletions >= this.stableCompletionsToScaleUp) {
      this.limit = Math.min(this.maxWorkers, this.limit + 1)
      this.stableCompletions = 0
    }
    return this.limit
  }

  recordBackpressure(reference = Date.now()): number {
    this.limit = Math.max(this.minWorkers, Math.ceil(this.limit / 2))
    this.stableCompletions = 0
    this.cooldownUntil = reference + this.cooldownMs
    return this.limit
  }

  desiredWorkers(
    activePublicJobs: number,
    activeSemanticReviews: number,
    availableMemoryRatio = 1
  ): number {
    const normalizedMemory = Number.isFinite(availableMemoryRatio)
      ? Math.max(0, Math.min(1, availableMemoryRatio))
      : 1
    const memoryLimit = normalizedMemory < 0.12
      ? 1
      : normalizedMemory < 0.2
        ? 2
        : normalizedMemory < 0.3
          ? 3
          : this.maxWorkers
    return desiredCodexWorkerCount(
      activePublicJobs,
      activeSemanticReviews,
      Math.min(this.limit, memoryLimit)
    )
  }
}
export type CodexWorkerTransportMode = 'websocket_preferred' | 'https_compatibility'

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
  transportMode?: CodexWorkerTransportMode
  env?: NodeJS.ProcessEnv
  findExecutable?: () => string | null
  spawnProcess?: typeof spawn
  onEvent?: (event: CodexScheduleWorkerEvent) => void
}

export function codexWorkerTransportArguments(
  mode: CodexWorkerTransportMode = 'websocket_preferred'
): string[] {
  if (mode !== 'https_compatibility') return []
  return [
    '-c',
    'model_provider="gacha-chatgpt-http"',
    '-c',
    'model_providers.gacha-chatgpt-http.name="ChatGPT HTTPS compatibility"',
    '-c',
    'model_providers.gacha-chatgpt-http.base_url="https://chatgpt.com/backend-api/codex"',
    '-c',
    'model_providers.gacha-chatgpt-http.wire_api="responses"',
    '-c',
    'model_providers.gacha-chatgpt-http.requires_openai_auth=true',
    '-c',
    'model_providers.gacha-chatgpt-http.supports_websockets=false'
  ]
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
  return `必须使用 $sync-gacha-schedules 技能处理 Gtask 的后台同步队列。
你是由桌面应用自动启动的本地后台 Agent，不要修改项目源码，也不要要求用户回复。
用户已经在桌面应用中主动点击同步，明确授权本轮读取公开资料，并由你决定对本次契约范围内的同步数据执行新增、更新或软删除；该授权不包含凭据读取、跨版块写入或删除受保护的手动数据。
请使用固定 Agent ID“${agentId}”、名称“Gtask 后台 Codex”登记联网能力。
领取任务后先读取 job.contract；它是当前版块所需数据、字段语义和完成条件的唯一权威来源。先按契约建立完整目录，再逐项检索必需字段，不要从提示词猜字段要求。
必须按 job.contract.requestContext 的 outputLocale 和 userTimeZone 组织结果，并在提交时原样回传 contentLocale。
处理个人同步语义候选时，以候选携带的接口契约和 matchCandidates 为准。应用只会在当前版块的公开规范清单已经建立后开放候选；个人接口目录、标题、时间、层级和来源标识都只是观测证据，不能反向替代规范清单。由你判断是匹配已有规范项目还是经核验后新增；确认是同一事项时填写 matchItemId，确认存在同步重复项时使用 archiveItems 保留最合适的规范承载项。
只领取一项公开资料任务并完整处理，严格按技能要求更新每个阶段的用户可见进度；已领取任务必须提交或明确失败。
若 target=all，先提交已核验版块以安全保存；只要工具返回 remainingTargets 或任务仍为 claimed，就继续使用 Codex 原生联网检索自主补齐，不得把部分结果宣布为完成。
不要自设搜索次数、固定来源路线或更短超时；根据搜索结果自由调整关键词和来源。只有确实穷尽有用检索后才能明确失败。
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
  if (env.USERPROFILE) {
    candidates.push(
      join(env.USERPROFILE, '.codex', 'plugins', '.plugin-appserver', executableName)
    )
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
  private readonly intentionallyStoppedChildren = new WeakSet<ChildProcess>()

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
      findCodexCli({ env: { ...process.env, ...this.options.env } })))()
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
      ...codexWorkerTransportArguments(this.options.transportMode),
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
      if (this.child === child) this.child = null
      if (this.intentionallyStoppedChildren.has(child)) return
      this.options.onEvent?.({
        agentId: this.agentId,
        phase: 'stopped',
        message: `Codex 自动进程启动失败：${error.message}`,
        exitCode: null
      })
    })
    child.once('exit', (exitCode) => {
      if (this.child === child) this.child = null
      if (this.intentionallyStoppedChildren.has(child)) return
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
    if (this.child && this.child.exitCode === null) {
      this.intentionallyStoppedChildren.add(this.child)
      this.child.kill()
    }
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
        message: `正在启动 Codex 并行处理进程（${running}/${desired}，动态上限 ${this.workers.length}）`,
        started,
        running
      }
    }
    return {
      status: 'already_running',
      message: running > 1
        ? `${running} 个 Codex 并行处理进程已运行（动态目标 ${desired}/${this.workers.length}），正在领取任务`
        : 'Codex 自动处理进程已运行，正在领取任务',
      started,
      running
    }
  }

  stop(): void {
    for (const worker of this.workers) worker.stop()
  }

  stopAgent(agentId: string): boolean {
    const worker = this.workers.find((candidate) => candidate.agentId === agentId)
    if (!worker || !worker.isRunning()) return false
    worker.stop()
    return true
  }
}
