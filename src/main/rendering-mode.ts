import { readFileSync } from 'node:fs'
import { writeFileAtomically } from './atomic-file'
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
  writeFileAtomically(filePath, `${JSON.stringify({ mode: parsedMode }, null, 2)}\n`)
  return parsedMode
}
