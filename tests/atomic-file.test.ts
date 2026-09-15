import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeFileAtomically } from '../src/main/atomic-file'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

describe('atomic durable file writes', () => {
  it('preserves the previous complete file if the replacement cannot commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-atomic-file-'))
    const path = join(directory, 'settings.json')
    try {
      writeFileAtomically(path, '{"generation":1}')
      vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('replacement blocked') })
      expect(() => writeFileAtomically(path, '{"generation":2}')).toThrow('replacement blocked')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ generation: 1 })
      expect(readdirSync(directory)).toEqual(['settings.json'])
      writeFileAtomically(path, '{"generation":3}')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ generation: 3 })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
