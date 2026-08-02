import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RenderingMode } from '../shared/contracts'

export const DEFAULT_RENDERING_MODE: RenderingMode = 'compatibility'

export function parseRenderingMode(value: unknown): RenderingMode {
  return value === 'accelerated' || value === 'compatibility'
    ? value
    : DEFAULT_RENDERING_MODE
}

export function readRenderingMode(filePath: string): RenderingMode {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { mode?: unknown }
    return parseRenderingMode(parsed.mode)
  } catch {
    return DEFAULT_RENDERING_MODE
  }
}

export function writeRenderingMode(filePath: string, mode: RenderingMode): RenderingMode {
  const parsedMode = parseRenderingMode(mode)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify({ mode: parsedMode }, null, 2)}\n`, 'utf8')
  return parsedMode
}
