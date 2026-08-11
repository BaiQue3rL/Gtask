import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JsonFeedUpdateProvider,
  SoftwareUpdateService,
  compareSoftwareVersions,
  createDefaultSoftwareUpdateProviders,
  readSoftwareUpdateSettings,
  writeSoftwareUpdateSettings
} from '../src/main/software-update'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('software update service', () => {
  it('compares release versions numerically', () => {
    expect(compareSoftwareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareSoftwareVersions('v1.0', '1.0.0')).toBe(0)
    expect(compareSoftwareVersions('1.0.0', '1.0.1')).toBe(-1)
  })

  it('does not make a network request while the update source is blank', async () => {
    const fetcher = vi.fn()
    const service = new SoftwareUpdateService('1.0.0', [
      new JsonFeedUpdateProvider('primary', '', fetcher)
    ])

    await expect(service.check()).resolves.toMatchObject({
      outcome: 'unavailable',
      checkedAt: null,
      message: '当前版本暂未提供在线更新'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns an available release from any configured provider', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.1.0', releaseUrl: 'https://example.com/gtask' })
    }))
    const service = new SoftwareUpdateService('1.0.0', [
      new JsonFeedUpdateProvider('primary', 'https://example.com/releases.json', fetcher)
    ])

    await expect(service.check(new Date('2026-08-02T12:00:00.000Z'))).resolves.toEqual({
      outcome: 'update_available',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      releaseUrl: 'https://example.com/gtask',
      checkedAt: '2026-08-02T12:00:00.000Z',
      message: '发现新版本 1.1.0'
    })
  })

  it('uses the release page matching the successful mirror', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        version: '1.1.0',
        releaseUrl: 'https://github.com/BaiQue3rL/Gtask/releases/latest',
        releaseUrls: {
          gitee: 'https://gitee.com/l3rui/Gtask/releases/tag/v1.1.0',
          github: 'https://github.com/BaiQue3rL/Gtask/releases/tag/v1.1.0'
        }
      })
    }))

    await expect(new JsonFeedUpdateProvider(
      'gitee',
      'https://gitee.example/latest.json',
      fetcher
    ).check(new AbortController().signal)).resolves.toEqual({
      version: '1.1.0',
      releaseUrl: 'https://gitee.com/l3rui/Gtask/releases/tag/v1.1.0'
    })
  })

  it('checks Gitee before GitHub and falls back when the mirror fails', async () => {
    const requestedUrls: string[] = []
    const fetcher = vi.fn(async (input: string | Request) => {
      const url = input.toString()
      requestedUrls.push(url)
      if (url.includes('gitee.com')) return { ok: false, status: 503, json: async () => ({}) }
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '1.0.1', releaseUrl: 'https://github.com/BaiQue3rL/Gtask/releases/latest' })
      }
    })
    const service = new SoftwareUpdateService('1.0.0', createDefaultSoftwareUpdateProviders({
      fetcher
    }))

    await expect(service.check()).resolves.toMatchObject({
      outcome: 'update_available',
      latestVersion: '1.0.1',
      releaseUrl: 'https://github.com/BaiQue3rL/Gtask/releases/latest'
    })
    expect(requestedUrls).toEqual([
      'https://gitee.com/l3rui/Gtask/raw/main/updates/latest.json',
      'https://raw.githubusercontent.com/BaiQue3rL/Gtask/main/updates/latest.json'
    ])
  })

  it('respects an explicitly selected repository without adding another fallback', () => {
    expect(createDefaultSoftwareUpdateProviders({ source: 'gitee' }).map(({ id }) => id))
      .toEqual(['override', 'gitee'])
    expect(createDefaultSoftwareUpdateProviders({ source: 'github' }).map(({ id }) => id))
      .toEqual(['override', 'github'])
    expect(createDefaultSoftwareUpdateProviders({ source: 'auto' }).map(({ id }) => id))
      .toEqual(['override', 'gitee', 'github'])
  })

  it('bounds a stalled update source without throwing into startup', async () => {
    const service = new SoftwareUpdateService('1.0.0', [{
      id: 'stalled',
      configured: true,
      check: () => new Promise(() => undefined)
    }], 5)

    await expect(service.check()).resolves.toMatchObject({
      outcome: 'error',
      checkedAt: null,
      message: '暂时无法检查更新，请稍后重试'
    })
  })

  it('falls back to the next repository when the primary source fails', async () => {
    const service = new SoftwareUpdateService('1.0.0', [
      {
        id: 'primary',
        configured: true,
        check: async () => { throw new Error('network unavailable') }
      },
      {
        id: 'mirror',
        configured: true,
        check: async () => ({
          version: '1.0.1',
          releaseUrl: 'https://example.com/gtask/releases'
        })
      }
    ])

    await expect(service.check(new Date('2026-08-10T12:00:00.000Z'))).resolves.toMatchObject({
      outcome: 'update_available',
      latestVersion: '1.0.1',
      releaseUrl: 'https://example.com/gtask/releases'
    })
  })

  it('persists only Gtask update preferences and the last successful check', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-update-settings-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'nested', 'software-update.json')
    const written = writeSoftwareUpdateSettings(filePath, {
      autoCheckEnabled: false,
      updateSource: 'github',
      lastSuccessfulCheckAt: '2026-08-02T12:00:00+08:00',
      lastAutomaticCheckAt: '2026-08-02T11:00:00+08:00'
    })

    expect(written).toEqual({
      autoCheckEnabled: false,
      updateSource: 'github',
      lastSuccessfulCheckAt: '2026-08-02T04:00:00.000Z',
      lastAutomaticCheckAt: '2026-08-02T03:00:00.000Z'
    })
    expect(readSoftwareUpdateSettings(filePath)).toEqual(written)
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(written)
  })

  it('migrates older settings files to automatic mirror fallback', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-old-update-settings-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'software-update.json')
    writeFileSync(filePath, JSON.stringify({
      autoCheckEnabled: false,
      lastSuccessfulCheckAt: '2026-08-02T04:00:00.000Z'
    }))

    expect(readSoftwareUpdateSettings(filePath)).toEqual({
      autoCheckEnabled: false,
      updateSource: 'auto',
      lastSuccessfulCheckAt: '2026-08-02T04:00:00.000Z',
      lastAutomaticCheckAt: null
    })
  })
})
