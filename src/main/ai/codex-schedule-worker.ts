import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { delimiter, join } from 'node:path'
import type {
  AiScheduleJob,
  CodexReasoningEffort,
  CodexWorkerModel,
  CodexWorkerPreferences
} from '../../shared/contracts'

export const CODEX_SCHEDULE_WORKER_AGENT_ID = 'gtask-background-worker'
export const MAX_CODEX_SCHEDULE_WORKERS = 6

export interface CodexWorkerRoute {
  jobId: string
  model: Exclude<CodexWorkerModel, 'inherit'> | 'inherit'
  reasoningEffort: CodexReasoningEffort
  label: string
  timeoutMs: number
  totalBudgetMs: number
  requiresWeb: boolean
}

export function resolveCodexWorkerRoute(
  job: AiScheduleJob,
  preferences: CodexWorkerPreferences
): CodexWorkerRoute {
  return {
    jobId: job.id,
    model: preferences.model,
    reasoningEffort: preferences.reasoningEffort,
    label: '自定义配置',
    timeoutMs: 20 * 60_000,
    totalBudgetMs: 25 * 60_000,
    requiresWeb: true
  }
}

export interface CodexWorkerSelectionOptions {
  jobs: AiScheduleJob[]
  runningRoutes: CodexWorkerRoute[]
  preferences: CodexWorkerPreferences
  maxWorkers?: number
  maxPerGame?: number
  maxWebWorkers?: number
  maxSolWorkers?: number
}

export function selectCodexWorkerRoutes({
  jobs,
  runningRoutes,
  preferences,
  maxWorkers = MAX_CODEX_SCHEDULE_WORKERS,
  maxPerGame = 2,
  maxWebWorkers = MAX_CODEX_SCHEDULE_WORKERS,
  maxSolWorkers = MAX_CODEX_SCHEDULE_WORKERS
}: CodexWorkerSelectionOptions): CodexWorkerRoute[] {
  const runningJobIds = new Set(runningRoutes.map((route) => route.jobId))
  const executingJobIds = new Set([
    ...runningJobIds,
    ...jobs.filter((job) => job.status === 'claimed').map((job) => job.id)
  ])
  const runningRouteByJobId = new Map(runningRoutes.map((route) => [route.jobId, route]))
  const gameCounts = new Map<string, number>()
  let webCount = 0
  let solCount = 0
  for (const job of jobs.filter((candidate) => executingJobIds.has(candidate.id))) {
    gameCounts.set(job.gameId, (gameCounts.get(job.gameId) ?? 0) + 1)
    const route = runningRouteByJobId.get(job.id) ?? resolveCodexWorkerRoute(job, preferences)
    if (route.requiresWeb) webCount += 1
    if (route.model === 'gpt-5.6-sol') solCount += 1
  }

  const selected: CodexWorkerRoute[] = []
  for (const job of jobs
    .filter((candidate) => candidate.status === 'pending' && !runningJobIds.has(candidate.id))
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))) {
    if (runningRoutes.length + selected.length >= maxWorkers) break
    if ((gameCounts.get(job.gameId) ?? 0) >= maxPerGame) continue
    const route = resolveCodexWorkerRoute(job, preferences)
    if (route.requiresWeb && webCount >= maxWebWorkers) continue
    if (route.model === 'gpt-5.6-sol' && solCount >= maxSolWorkers) continue
    selected.push(route)
    gameCounts.set(job.gameId, (gameCounts.get(job.gameId) ?? 0) + 1)
    if (route.requiresWeb) webCount += 1
    if (route.model === 'gpt-5.6-sol') solCount += 1
  }
  return selected
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
  jobId?: string | null
  phase:
    | 'starting'
    | 'initializing'
    | 'connecting'
    | 'retrying'
    | 'fallback'
    | 'authorization'
    | 'configuration'
    | 'timeout'
    | 'stopped'
  message: string
  current?: number
  total?: number
  exitCode?: number | null
  timedOut?: boolean
  model?: CodexWorkerRoute['model']
  reasoningEffort?: CodexWorkerRoute['reasoningEffort']
  startedAt?: string
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
    'model_provider="gtask-chatgpt-http"',
    '-c',
    'model_providers.gtask-chatgpt-http.name="ChatGPT HTTPS compatibility"',
    '-c',
    'model_providers.gtask-chatgpt-http.base_url="https://chatgpt.com/backend-api/codex"',
    '-c',
    'model_providers.gtask-chatgpt-http.wire_api="responses"',
    '-c',
    'model_providers.gtask-chatgpt-http.requires_openai_auth=true',
    '-c',
    'model_providers.gtask-chatgpt-http.supports_websockets=false'
  ]
}

export function codexWorkerInferenceArguments(
  preferences: CodexWorkerPreferences = {
    strategy: 'fixed',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium'
  }
): string[] {
  const args: string[] = []
  if (preferences.model !== 'inherit') args.push('--model', preferences.model)
  if (preferences.reasoningEffort !== 'inherit') {
    args.push('-c', `model_reasoning_effort="${preferences.reasoningEffort}"`)
  }
  return args
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
  canStartWorkers?: () => boolean
  unavailableMessage?: string
}

function backgroundPrompt(agentId: string, route: CodexWorkerRoute): string {
  return `必须使用 $sync-gtask-schedules 技能处理 Gtask 后台基准表维护任务。你是桌面应用启动的本地后台 Agent，不要修改项目源码，也不要要求用户回复。使用固定 Agent ID“${agentId}”登记，只领取任务“${route.jobId}”；领取时传入 jobId="${route.jobId}"、model="${route.model}"、reasoningEffort="${route.reasoningEffort}"。先阅读 job.contract、当前基准和脱敏 sourceObservations；第一方观察足以支持的字段直接引用，只有缺失或冲突字段再联网补查。只能通过 MCP 的结构化基准表工具写入，不得读取凭据、原始个人账号数据或更改用户完成状态。任务不存在或已被领取时立即退出；已领取任务必须提交完整结果或明确失败，每次续接都使用返回的新 contract，完成后退出，不领取第二项任务。`
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
      /protocol|incompatible|协议版本|插件版本/i.test(event.item.error?.message ?? '')
    ) {
      return {
        phase: 'configuration',
        message: 'Gtask 管理端契约不兼容，请刷新本机 Codex 维护插件后重试'
      }
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
  private activeRoute: CodexWorkerRoute | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private readonly intentionallyStoppedChildren = new WeakSet<ChildProcess>()

  constructor(private readonly options: CodexScheduleWorkerOptions) {}

  get agentId(): string {
    return this.options.agentId ?? CODEX_SCHEDULE_WORKER_AGENT_ID
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.stopped)
  }

  get jobId(): string | null {
    return this.activeRoute?.jobId ?? null
  }

  get route(): CodexWorkerRoute | null {
    return this.activeRoute
  }

  start(route: CodexWorkerRoute): CodexScheduleWorkerLaunchResult {
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
    this.activeRoute = route
    const startedAt = new Date().toISOString()
    const spawnProcess = this.options.spawnProcess ?? spawn
    const child = spawnProcess(executablePath, [
      'exec',
      '--ephemeral',
      '--json',
      '--color',
      'never',
      ...codexWorkerTransportArguments(this.options.transportMode),
      ...codexWorkerInferenceArguments({
        strategy: 'fixed',
        model: route.model,
        reasoningEffort: route.reasoningEffort
      }),
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="on-request"',
      '-c',
      'approvals_reviewer="auto_review"',
      '--skip-git-repo-check',
      '-C',
      this.options.workingDirectory,
      backgroundPrompt(this.agentId, route)
    ], {
      cwd: this.options.workingDirectory,
      env: { ...process.env, ...this.options.env, CODEX_GTASK_BACKGROUND: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.options.onEvent?.({
      agentId: this.agentId,
      jobId: route.jobId,
      phase: 'starting',
      message: `Codex ${route.label}正在启动 · ${route.model}/${route.reasoningEffort}`,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      startedAt
    })

    this.timeoutTimer = setTimeout(() => {
      if (this.child !== child || child.exitCode !== null) return
      this.options.onEvent?.({
        agentId: this.agentId,
        jobId: route.jobId,
        phase: 'timeout',
        message: `${route.label}达到单次时间预算，已安全结束当前任务`,
        exitCode: null,
        timedOut: true,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        startedAt
      })
      this.stop()
    }, route.timeoutMs)

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let lastFailureMessage: string | null = null
    let terminalEventHandled = false
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
          this.options.onEvent?.({
            ...event,
            agentId: this.agentId,
            jobId: route.jobId,
            model: route.model,
            reasoningEffort: route.reasoningEffort,
            startedAt
          })
        }
      }
    }
    child.stdout?.on('data', (chunk) => consume(chunk, 'stdout'))
    child.stderr?.on('data', (chunk) => consume(chunk, 'stderr'))
    child.once('error', (error) => {
      if (terminalEventHandled) return
      terminalEventHandled = true
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
      const wasCurrentChild = this.child === child
      if (wasCurrentChild) this.child = null
      if (wasCurrentChild && this.activeRoute?.jobId === route.jobId) this.activeRoute = null
      if (this.intentionallyStoppedChildren.has(child)) return
      this.options.onEvent?.({
        agentId: this.agentId,
        jobId: route.jobId,
        phase: 'stopped',
        message: `Codex 自动进程启动失败：${error.message}`,
        exitCode: null,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        startedAt
      })
    })
    child.once('exit', (exitCode) => {
      if (terminalEventHandled) return
      terminalEventHandled = true
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
      const wasCurrentChild = this.child === child
      if (wasCurrentChild) this.child = null
      if (wasCurrentChild && this.activeRoute?.jobId === route.jobId) this.activeRoute = null
      if (this.intentionallyStoppedChildren.has(child)) return
      this.options.onEvent?.({
        agentId: this.agentId,
        jobId: route.jobId,
        phase: 'stopped',
        message: exitCode === 0
          ? lastFailureMessage ?? '同步服务已停止'
          : '同步服务意外停止，请稍后重试',
        exitCode,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        startedAt
      })
    })

    return {
      status: 'started',
      message: '正在启动同步服务',
      executablePath
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.timeoutTimer = null
    if (this.child && this.child.exitCode === null) {
      this.intentionallyStoppedChildren.add(this.child)
      const pid = this.child.pid
      if (process.platform === 'win32' && typeof pid === 'number') {
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
        const result = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore'
        })
        if (result.error) this.child.kill()
      } else {
        this.child.kill()
      }
    }
    this.child = null
    this.activeRoute = null
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

  get runningRoutes(): CodexWorkerRoute[] {
    return this.workers.flatMap((worker) => worker.isRunning() && worker.route
      ? [worker.route]
      : [])
  }

  startJobs(routes: CodexWorkerRoute[]): CodexScheduleWorkerPoolLaunchResult {
    if (this.options.canStartWorkers && !this.options.canStartWorkers()) {
      return {
        status: 'unavailable',
        message: this.options.unavailableMessage ?? 'Codex 同步插件尚未就绪',
        started: 0,
        running: this.runningCount
      }
    }
    let started = 0
    let unavailableMessage: string | null = null
    const assigned = new Set(this.runningRoutes.map((route) => route.jobId))
    for (const route of routes) {
      if (assigned.has(route.jobId)) continue
      const worker = this.workers.find((candidate) => !candidate.isRunning())
      if (!worker) break
      const launch = worker.start(route)
      if (launch.status === 'started') {
        started += 1
        assigned.add(route.jobId)
      }
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
        message: '同步服务正在启动',
        started,
        running
      }
    }
    return {
      status: 'already_running',
      message: running > 0 ? '同步任务正在处理' : '同步任务正在排队',
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
