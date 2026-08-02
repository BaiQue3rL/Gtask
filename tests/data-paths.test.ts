import { describe, expect, it } from 'vitest'
import { resolveAppDataPaths } from '../src/main/data-paths'

describe('app data paths', () => {
  it('uses the Windows Documents location without assuming a drive letter', () => {
    const paths = resolveAppDataPaths('X:\\Redirected\\Documents')
    expect(paths.root).toBe('X:\\Redirected\\Documents\\GachaTaskManager')
    expect(paths.database).toBe(
      'X:\\Redirected\\Documents\\GachaTaskManager\\data\\gacha-task-manager.sqlite'
    )
  })
})
