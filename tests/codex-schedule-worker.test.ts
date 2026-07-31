import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ChildProcess, spawn } from 'node:child_process'
import type { CodexWorkerPreferences } from '../src/shared/contracts'
import {
  CODEX_SCHEDULE_WORKER_AGENT_ID,
  CodexDynamicConcurrencyController,
  CodexScheduleWorker,
  CodexScheduleWorkerPool,
  codexWorkerInferenceArguments,
  codexWorkerTransportArguments,
  codexScheduleWorkerAgentId,
  desiredCodexWorkerCount,
  findCodexCli,
  parseCodexWorkerLine
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
  it('uses a bounded reusable worker group for semantic-review queues', () => {
    expect(desiredCodexWorkerCount(0, 51)).toBe(2)
    expect(desiredCodexWorkerCount(1, 51)).toBe(3)
    expect(desiredCodexWorkerCount(4, 51)).toBe(6)
    expect(desiredCodexWorkerCount(10, 10, 2)).toBe(2)
    expect(desiredCodexWorkerCount(0, 0)).toBe(0)
  })

  it('ramps concurrency up after stable completions and backs off on pressure', () => {
    const controller = new CodexDynamicConcurrencyController({
      minWorkers: 2,
      maxWorkers: 6,
      stableCompletionsToScaleUp: 2,
      cooldownMs: 1_000
    })

    expect(controller.desiredWorkers(10, 0)).toBe(2)
    expect(controller.recordHealthyCompletion(true, 0)).toBe(2)
    expect(controller.recordHealthyCompletion(true, 1)).toBe(3)
    expect(controller.recordHealthyCompletion(true, 2)).toBe(3)
    expect(controller.recordHealthyCompletion(true, 3)).toBe(4)
    expect(controller.recordBackpressure(10)).toBe(2)
    expect(controller.recordHealthyCompletion(true, 11)).toBe(2)
    expect(controller.recordHealthyCompletion(true, 12)).toBe(2)
    expect(controller.recordHealthyCompletion(true, 1_011)).toBe(2)
    expect(controller.recordHealthyCompletion(true, 1_012)).toBe(3)
    expect(controller.desiredWorkers(10, 0, 0.1)).toBe(1)
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

    worker.start()

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
    expect(codexWorkerInferenceArguments()).toEqual([])
    expect(codexWorkerInferenceArguments({
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

    expect(worker.start().status).toBe('started')
    expect(worker.start().status).toBe('already_running')
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
    expect(worker.start()).toEqual({
      status: 'unavailable',
      message: '未找到本机 Codex CLI；请先安装或登录 Codex 后重试',
      executablePath: null
    })
  })

  it('reads the latest Gtask inference preference for every new worker launch', () => {
    const children: FakeChildProcess[] = []
    const launches: string[][] = []
    let preferences: CodexWorkerPreferences = {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high'
    }
    const spawnProcess = ((_command: string, args: readonly string[] = []) => {
      launches.push([...args])
      const child = new FakeChildProcess()
      children.push(child)
      return child as unknown as ChildProcess
    }) as unknown as typeof spawn
    const worker = new CodexScheduleWorker({
      workingDirectory: 'C:\\GachaData',
      findExecutable: () => 'C:\\Codex\\codex.exe',
      spawnProcess,
      resolvePreferences: () => preferences
    })

    worker.start()
    expect(launches[0]).toEqual(expect.arrayContaining([
      '--model',
      'gpt-5.6-sol',
      'model_reasoning_effort="high"'
    ]))
    children[0].exitCode = 0
    children[0].emit('exit', 0)
    preferences = { model: 'gpt-5.6-terra', reasoningEffort: 'ultra' }
    worker.start()
    expect(launches[1]).toEqual(expect.arrayContaining([
      '--model',
      'gpt-5.6-terra',
      'model_reasoning_effort="ultra"'
    ]))
  })

  it('starts up to the dynamic ceiling with uniquely identified workers', () => {
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

    expect(pool.ensureCapacity(6)).toMatchObject({
      status: 'started',
      started: 6,
      running: 6
    })
    expect(pool.ensureCapacity(10)).toMatchObject({
      status: 'already_running',
      started: 0,
      running: 6
    })
    expect(children).toHaveLength(6)
    for (let slot = 1; slot <= 6; slot += 1) {
      expect(prompts.some((prompt) =>
        prompt.includes(codexScheduleWorkerAgentId(slot))
      )).toBe(true)
    }

    children[0].exitCode = 1
    children[0].emit('exit', 1)
    expect(stoppedAgents).toEqual([codexScheduleWorkerAgentId(1)])
    expect(pool.runningCount).toBe(5)
    expect(children.slice(1, 6).every((child) => child.exitCode === null)).toBe(true)
    expect(pool.ensureCapacity(6)).toMatchObject({
      status: 'started',
      started: 1,
      running: 6
    })
    expect(children).toHaveLength(7)
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

    pool.ensureCapacity(3)
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

    pool.ensureCapacity(4)
    expect(pool.runningCount).toBe(4)

    pool.stop()

    expect(pool.runningCount).toBe(0)
    expect(children.every((child) => child.exitCode === 0)).toBe(true)
  })
})
