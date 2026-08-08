import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'

export type ApplicationLogLevel = 'info' | 'warn' | 'error'

export interface ApplicationLoggerOptions {
  maximumBytes?: number
  retainedFiles?: number
  now?: () => Date
}

const DEFAULT_MAXIMUM_BYTES = 2 * 1024 * 1024
const DEFAULT_RETAINED_FILES = 5
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|phone|secret|token|ticket)/i

function sanitizeText(value: string): string {
  return value
    .replace(/\b1\d{10}\b/g, '[redacted-phone]')
    .replace(
      /((?:authorization|cookie|password|secret|token|ticket)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[redacted]'
    )
}

function sanitizeValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') return sanitizeText(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeText(value.message),
      stack: value.stack ? sanitizeText(value.stack) : undefined
    }
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, '', seen))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([entryKey, entryValue]) => [entryKey, sanitizeValue(entryValue, entryKey, seen)])
  )
}

export class ApplicationLogger {
  readonly filePath: string
  private readonly maximumBytes: number
  private readonly retainedFiles: number
  private readonly now: () => Date

  constructor(
    readonly directory: string,
    options: ApplicationLoggerOptions = {}
  ) {
    this.maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES
    this.retainedFiles = options.retainedFiles ?? DEFAULT_RETAINED_FILES
    this.now = options.now ?? (() => new Date())
    if (!Number.isInteger(this.maximumBytes) || this.maximumBytes < 1024) {
      throw new Error('日志轮换大小必须是不小于 1024 的整数')
    }
    if (!Number.isInteger(this.retainedFiles) || this.retainedFiles < 1) {
      throw new Error('日志保留数量必须是正整数')
    }
    mkdirSync(directory, { recursive: true })
    this.filePath = join(directory, 'gtask.log')
  }

  info(event: string, details?: unknown): void {
    this.write('info', event, details)
  }

  warn(event: string, details?: unknown): void {
    this.write('warn', event, details)
  }

  error(event: string, details?: unknown): void {
    this.write('error', event, details)
  }

  private write(level: ApplicationLogLevel, event: string, details?: unknown): void {
    try {
      const entry = {
        timestamp: this.now().toISOString(),
        level,
        event: sanitizeText(event),
        ...(details === undefined ? {} : { details: sanitizeValue(details) })
      }
      const line = `${JSON.stringify(entry)}\n`
      this.rotateIfNeeded(Buffer.byteLength(line, 'utf8'))
      appendFileSync(this.filePath, line, 'utf8')
    } catch {
      // Logging must never interrupt startup, synchronization, or shutdown.
    }
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (!existsSync(this.filePath)) return
    if (statSync(this.filePath).size + incomingBytes <= this.maximumBytes) return

    const oldest = `${this.filePath}.${this.retainedFiles}`
    rmSync(oldest, { force: true })
    for (let index = this.retainedFiles - 1; index >= 1; index -= 1) {
      const source = `${this.filePath}.${index}`
      if (existsSync(source)) renameSync(source, `${this.filePath}.${index + 1}`)
    }
    renameSync(this.filePath, `${this.filePath}.1`)
  }
}
