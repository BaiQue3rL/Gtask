import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RENDERING_MODE,
  parseRenderingMode,
  readRenderingMode,
  writeRenderingMode
} from '../src/main/rendering-mode'

describe('界面渲染模式', () => {
  it('首次运行和损坏配置都使用兼容模式', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-rendering-'))
    const filePath = join(directory, 'rendering-mode.json')
    expect(readRenderingMode(filePath)).toBe(DEFAULT_RENDERING_MODE)
    expect(parseRenderingMode('unknown')).toBe('compatibility')
  })

  it('持久化只属于 Gtask 的加速模式设置', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-rendering-'))
    const filePath = join(directory, 'settings', 'rendering-mode.json')
    expect(writeRenderingMode(filePath, 'accelerated')).toBe('accelerated')
    expect(readRenderingMode(filePath)).toBe('accelerated')
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ mode: 'accelerated' })
  })
})
