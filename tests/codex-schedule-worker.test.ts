import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { ChildProcess, spawn } from 'node:child_process'
import {
  CODEX_SCHEDULE_WORKER_AGENT_ID,
  CodexScheduleWorker,
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
})
