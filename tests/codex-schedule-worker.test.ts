import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ChildProcess, spawn } from 'node:child_process'
import type { AiScheduleJob, CodexWorkerPreferences } from '../src/shared/contracts'
import {
  CODEX_SCHEDULE_WORKER_AGENT_ID,
  CodexScheduleWorker,
  CodexScheduleWorkerPool,
  codexWorkerInferenceArguments,
  codexWorkerTransportArguments,
  codexScheduleWorkerAgentId,
  findCodexCli,
  parseCodexWorkerLine,
  resolveCodexWorkerRoute,
  selectCodexWorkerRoutes,
  type CodexWorkerRoute
} from '../src/main/ai/codex-schedule-worker'

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  spawnfile = 'C:\\Codex\\codex.exe'

  kill(): boolean {
    this.exitCode = 0
    return true
  }
}

describe('Codex schedule worker', () => {
  const route = (
    jobId: string,
    model: CodexWorkerRoute['model'] = 'gpt-5.6-luna'
  ): CodexWorkerRoute => ({
    jobId,
    model,
    reasoningEffort: 'low',
    label: '快速核验',
    timeoutMs: 60_000,
    totalBudgetMs: 120_000,
    requiresWeb: false
  })

  it('uses one user-selected route for every task and ignores historical routing tiers', () => {
    const preferences: CodexWorkerPreferences = {
      strategy: 'fixed',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium'
    }
    const personal = { id: 'personal', jobKind: 'personal_review', routingTier: 0 } as AiScheduleJob
    const eventReview = {
      id: 'event-review', jobKind: 'personal_review', target: 'events', routingTier: 0
    } as AiScheduleJob
    const metadata = { id: 'metadata', jobKind: 'personal_metadata', routingTier: 0 } as AiScheduleJob
    const publicJob = { id: 'public', jobKind: 'public_catalog', routingTier: 2 } as AiScheduleJob
    expect(resolveCodexWorkerRoute(personal, preferences)).toMatchObject({
      model: 'gpt-5.6-sol', reasoningEffort: 'medium', requiresWeb: false
    })
    expect(resolveCodexWorkerRoute(eventReview, preferences)).toMatchObject({
      model: 'gpt-5.6-sol', reasoningEffort: 'medium', requiresWeb: true
    })
    expect(resolveCodexWorkerRoute(metadata, preferences)).toMatchObject({
      model: 'gpt-5.6-sol', reasoningEffort: 'medium', requiresWeb: true
    })
    expect(resolveCodexWorkerRoute(publicJob, preferences)).toMatchObject({
      model: 'gpt-5.6-sol', reasoningEffort: 'medium', requiresWeb: true
    })
  })

  it('selects a fixed six-slot batch while respecting per-game and expensive-route caps', () => {
    const preferences: CodexWorkerPreferences = {
      strategy: 'fixed',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium'
    }
    const job = (
      id: string,
      gameId: AiScheduleJob['gameId'],
      jobKind: AiScheduleJob['jobKind'] = 'personal_review',
      routingTier = 0
    ): AiScheduleJob => ({
      id,
      gameId,
      jobKind,
      routingTier,
      status: 'pending',
      requestedAt: `2026-08-01T12:00:${id.padStart(2, '0')}.000Z`
    } as AiScheduleJob)
    const personalJobs = [
      job('01', 'genshin'), job('02', 'genshin'), job('03', 'genshin'),
      job('04', 'star-rail'), job('05', 'star-rail'),
      job('06', 'zenless'), job('07', 'zenless'),
      job('08', 'wuthering-waves')
    ]
    const six = selectCodexWorkerRoutes({
      jobs: personalJobs,
      runningRoutes: [],
      preferences
    })
    expect(six).toHaveLength(6)
    expect(six.filter((selected) => selected.jobId === '03')).toHaveLength(0)

    const running = route('01')
    const nextForSameGame = selectCodexWorkerRoutes({
      jobs: personalJobs,
      runningRoutes: [running],
      preferences
    })
    expect(nextForSameGame.filter((selected) => ['02', '03'].includes(selected.jobId)))
      .toHaveLength(1)

    const expensiveJobs = [
      job('11', 'genshin', 'public_catalog', 2),
      job('12', 'star-rail', 'public_catalog', 2),
      job('13', 'zenless', 'public_catalog', 2),
      job('14', 'wuthering-waves', 'public_catalog', 2)
    ]
    expect(selectCodexWorkerRoutes({
      jobs: expensiveJobs,
      runningRoutes: [],
      preferences,
      maxWebWorkers: 6
    })).toHaveLength(4)

    const webJobs = [
      job('21', 'genshin', 'personal_metadata'),
      job('22', 'genshin', 'personal_metadata'),
      job('23', 'star-rail', 'personal_metadata'),
      job('24', 'star-rail', 'personal_metadata'),
      job('25', 'zenless', 'personal_metadata')
    ]
    expect(selectCodexWorkerRoutes({
      jobs: webJobs,
      runningRoutes: [],
      preferences
    })).toHaveLength(5)
  })

  it('keeps the parent process environment when worker-specific proxy variables are empty', () => {
    const executablePath = 'C:\\Users\\Tester\\AppData\\Local\\OpenAI\\Codex\\bin\\version\\codex.exe'
    let spawnOptions: Parameters<typeof spawn>[2] | undefined
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: Parameters<typeof spawn>[2]
    ) => {
      spawnOptions = options
      return new FakeChildProcess() as unknown as ChildProcess
    }) as typeof spawn
    const worker = new CodexScheduleWorker({
      workingDirectory: 'C:\\AppData\\gacha-task-manager',
      env: {},
      findExecutable: () => executablePath,
      spawnProcess
    })

    worker.start(route('job-env'))

    expect(spawnOptions).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        PATH: process.env.PATH,
        CODEX_GACHA_BACKGROUND: '1'
      })
    }))
  })

  it('uses a ChatGPT-authenticated HTTPS provider only for compatibility mode', () => {
    expect(codexWorkerTransportArguments()).toEqual([])
    const args = codexWorkerTransportArguments('https_compatibility')
    expect(args).toContain('model_provider="gacha-chatgpt-http"')
    expect(args).toContain('model_providers.gacha-chatgpt-http.supports_websockets=false')
    expect(args).toContain(
      'model_providers.gacha-chatgpt-http.base_url="https://chatgpt.com/backend-api/codex"'
    )
  })

  it('applies Gtask-only model and reasoning overrides without changing global config', () => {
    expect(codexWorkerInferenceArguments()).toEqual([
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="medium"'
    ])
    expect(codexWorkerInferenceArguments({
      strategy: 'fixed',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra'
    })).toEqual([
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort="ultra"'
    ])
  })

  it('prefers an explicit Codex CLI path', () => {
    expect(findCodexCli({
      env: {
        CODEX_CLI_PATH: 'C:\\custom\\codex.exe',
        PATH: 'C:\\other',
        LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local'
      },
      exists: (path) => path === 'C:\\custom\\codex.exe'
    })).toBe('C:\\custom\\codex.exe')
  })

  it('finds the newest Codex Desktop CLI', () => {
    const root = 'C:\\Users\\Tester\\AppData\\Local\\OpenAI\\Codex\\bin'
    expect(findCodexCli({
      env: { PATH: '', LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' },
      exists: (path) => path.endsWith('old\\codex.exe') || path.endsWith('new\\codex.exe'),
      listDirectories: (path) => path === root ? ['old', 'new'] : [],
      modifiedAt: (path) => path.includes('\\new\\') ? 2 : 1
    })).toBe(`${root}\\new\\codex.exe`)
  })

  it('finds the Codex plugin appserver CLI when it is not on PATH', () => {
    const executable = 'C:\\Users\\Tester\\.codex\\plugins\\.plugin-appserver\\codex.exe'
    expect(findCodexCli({
      env: {
        PATH: '',
        USERPROFILE: 'C:\\Users\\Tester'
      },
      exists: (path) => path === executable
    })).toBe(executable)
  })

  it('turns Codex retry diagnostics into user-visible counts', () => {
    expect(parseCodexWorkerLine(
      '{"type":"error","message":"Reconnecting... 3/5 (request timed out)"}'
    )).toEqual({
      phase: 'retrying',
      message: 'Codex 正在连接模型，重试 3/5',
      current: 3,
      total: 5
    })
    expect(parseCodexWorkerLine(
      'stream disconnected - retrying sampling request (1/5 in 216ms)'
    )).toEqual({
      phase: 'retrying',
      message: 'Codex 正在连接模型，重试 1/5',
      current: 1,
      total: 5
    })
  })

  it('reports a rejected MCP authorization in user-facing language', () => {
    expect(parseCodexWorkerLine(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        error: { message: 'user cancelled MCP tool call' }
      }
    }))).toEqual({
      phase: 'authorization',
      message: 'Codex 同步工具授权被拒绝，本次同步无法继续'
    })
  })

  it('stops immediately with an actionable message for an incompatible plugin protocol', () => {
    expect(parseCodexWorkerLine(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        error: { message: 'incompatible protocol version 2026-08-01.2' }
      }
    }))).toEqual({
      phase: 'configuration',
      message: 'Gtask 同步插件版本不兼容，请在设置中更新插件后重试'
    })
  })

  it('starts a read-only non-interactive Codex worker and streams phases', () => {
    const child = new FakeChildProcess()
    let spawnedArgs: readonly string[] = []
    const spawnProcess = ((_command: string, args: readonly string[] = []) => {
      spawnedArgs = args
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    const events: string[] = []
    const worker = new CodexScheduleWorker({
      workingDirectory: 'C:\\GachaData',
      findExecutable: () => 'C:\\Codex\\codex.exe',
      spawnProcess,
      onEvent: (event) => events.push(event.message)
    })

    expect(worker.start(route('job-readonly')).status).toBe('started')
    expect(worker.start(route('job-other')).status).toBe('already_running')
    expect(spawnedArgs).toContain('--ephemeral')
    expect(spawnedArgs).toContain('read-only')
    expect(spawnedArgs).toContain('approval_policy="on-request"')
    expect(spawnedArgs).toContain('approvals_reviewer="auto_review"')
    expect(spawnedArgs.join(' ')).toContain(CODEX_SCHEDULE_WORKER_AGENT_ID)

    child.stdout.write('{"type":"thread.started","thread_id":"test"}\n')
    child.stdout.write('{"type":"turn.started"}\n')
    child.stdout.write('{"type":"error","message":"Reconnecting... 2/5"}\n')
    expect(events).toContain('Codex 已启动，正在初始化同步插件')
    expect(events).toContain('Codex 已连接，正在领取同步任务')
    expect(events).toContain('Codex 正在连接模型，重试 2/5')
  })

  it('reports a missing CLI without starting a process', () => {
    const worker = new CodexScheduleWorker({
      workingDirectory: 'C:\\GachaData',
      findExecutable: () => null
    })
    expect(worker.start(route('job-missing'))).toEqual({
      status: 'unavailable',
      message: '未找到本机 Codex CLI；请先安装或登录 Codex 后重试',
      executablePath: null
    })
  })

  it('uses the exact route assigned before launching each worker', () => {
    const children: FakeChildProcess[] = []
    const launches: string[][] = []
    const spawnProcess = ((_command: string, args: readonly string[] = []) => {
      launches.push([...args])
      const child = new FakeChildProcess()
      children.push(child)
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    const worker = new CodexScheduleWorker({
      workingDirectory: 'C:\\GachaData',
      findExecutable: () => 'C:\\Codex\\codex.exe',
      spawnProcess
    })

    worker.start({ ...route('job-sol', 'gpt-5.6-sol'), reasoningEffort: 'high' })
    expect(launches[0]).toEqual(expect.arrayContaining([
      '--model',
      'gpt-5.6-sol',
      'model_reasoning_effort="high"'
    ]))
    children[0].exitCode = 0
    children[0].emit('exit', 0)
    worker.start({ ...route('job-terra', 'gpt-5.6-terra'), reasoningEffort: 'ultra' })
    expect(launches[1]).toEqual(expect.arrayContaining([
      '--model',
      'gpt-5.6-terra',
      'model_reasoning_effort="ultra"'
    ]))
  })

  it('reports a pre-claim process failure once with its exact route metadata', () => {
    const child = new FakeChildProcess()
    const events: Array<{ phase: string; jobId?: string | null; model?: string }> = []
    const worker = new CodexScheduleWorker({
      workingDirectory: 'C:\\GachaData',
      findExecutable: () => 'C:\\Codex\\codex.exe',
      spawnProcess: (() => child as unknown as ChildProcess) as unknown as typeof spawn,
      onEvent: (event) => events.push(event)
    })
    worker.start(route('preclaim-failure', 'gpt-5.6-terra'))
    child.emit('error', new Error('connection unavailable'))
    child.emit('exit', 1)

    expect(events.filter((event) => event.phase === 'stopped')).toEqual([
      expect.objectContaining({
        jobId: 'preclaim-failure',
        model: 'gpt-5.6-terra'
      })
    ])
    expect(worker.isRunning()).toBe(false)
    expect(worker.route).toBeNull()
  })

  it('starts up to six fixed slots with exact job assignments', () => {
    const children: FakeChildProcess[] = []
    const prompts: string[] = []
    const stoppedAgents: string[] = []
    const spawnProcess = ((_command: string, args: readonly string[] = []) => {
      const child = new FakeChildProcess()
      children.push(child)
      prompts.push(args.at(-1) ?? '')
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    const pool = new CodexScheduleWorkerPool({
      workingDirectory: 'C:\\GachaData',
      findExecutable: () => 'C:\\Codex\\codex.exe',
      spawnProcess,
      onEvent: (event) => {
        if (event.phase === 'stopped') stoppedAgents.push(event.agentId)
      }
    })

    expect(pool.startJobs(Array.from({ length: 6 }, (_, index) => route(`job-${index + 1}`)))).toMatchObject({
      status: 'started',
      started: 6,
      running: 6
    })
    expect(pool.startJobs(Array.from({ length: 10 }, (_, index) => route(`extra-${index + 1}`)))).toMatchObject({
      status: 'already_running',
      started: 0,
      running: 6
    })
    expect(children).toHaveLength(6)
    for (let slot = 1; slot <= 6; slot += 1) {
      expect(prompts.some((prompt) =>
        prompt.includes(codexScheduleWorkerAgentId(slot)) && prompt.includes(`job-${slot}`)
      )).toBe(true)
    }

    children[0].exitCode = 1
    children[0].emit('exit', 1)
    expect(stoppedAgents).toEqual([codexScheduleWorkerAgentId(1)])
    expect(pool.runningCount).toBe(5)
    expect(children.slice(1, 6).every((child) => child.exitCode === null)).toBe(true)
    expect(pool.startJobs([route('replacement')])).toMatchObject({
      status: 'started',
      started: 1,
      running: 6
    })
    expect(children).toHaveLength(7)
  })

  it('does not spawn Codex when the Gtask synchronization plugin is unavailable', () => {
    let spawnCount = 0
    const pool = new CodexScheduleWorkerPool({
      workingDirectory: 'C:\\GachaData',
      canStartWorkers: () => false,
      unavailableMessage: '请先安装同步插件',
      findExecutable: () => 'C:\\Codex\\codex.exe',
      spawnProcess: (() => {
        spawnCount += 1
        return new FakeChildProcess() as unknown as ChildProcess
      }) as unknown as typeof spawn
    })

    expect(pool.startJobs([route('blocked')])).toEqual({
      status: 'unavailable',
      message: '请先安装同步插件',
      started: 0,
      running: 0
    })
    expect(spawnCount).toBe(0)
  })

  it('stops only the requested worker and leaves parallel tasks running', () => {
    const children: FakeChildProcess[] = []
    const spawnProcess = (() => {
      const child = new FakeChildProcess()
      children.push(child)
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    const pool = new CodexScheduleWorkerPool({
      workingDirectory: 'C:\\GachaData',
      findExecutable: () => 'C:\\Codex\\codex.exe',
      spawnProcess
    })

    pool.startJobs([route('a'), route('b'), route('c')])
    expect(pool.stopAgent(codexScheduleWorkerAgentId(2))).toBe(true)
    expect(pool.runningCount).toBe(2)
    expect(children[0].exitCode).toBeNull()
    expect(children[1].exitCode).toBe(0)
    expect(children[2].exitCode).toBeNull()
    expect(pool.stopAgent('unknown-agent')).toBe(false)
  })

  it('stops every launched worker when the application exits', () => {
    const children: FakeChildProcess[] = []
    const spawnProcess = (() => {
      const child = new FakeChildProcess()
      children.push(child)
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    const pool = new CodexScheduleWorkerPool({
      workingDirectory: 'C:\\GachaData',
      findExecutable: () => 'C:\\Codex\\codex.exe',
      spawnProcess
    })

    pool.startJobs([route('a'), route('b'), route('c'), route('d')])
    expect(pool.runningCount).toBe(4)

    pool.stop()

    expect(pool.runningCount).toBe(0)
    expect(children.every((child) => child.exitCode === 0)).toBe(true)
  })
})
