import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  JsonFeedUpdateProvider,
  SoftwareUpdateService
} from '../src/main/software-update'

const onlineIt = process.env.GTASK_ONLINE_RELEASE_TEST === '1' ? it : it.skip
const giteeFeedUrl = 'https://gitee.com/l3rui/Gtask/raw/main/updates/latest.json'
const githubFeedUrl = 'https://raw.githubusercontent.com/BaiQue3rL/Gtask/main/updates/latest.json'
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }
const { releaseUrls } = JSON.parse(
  readFileSync(new URL('../updates/latest.json', import.meta.url), 'utf8')
) as { releaseUrls: { gitee: string; github: string } }

describe('published software update feed', () => {
  onlineIt('prefers Gitee and falls back to the authoritative GitHub feed', async () => {
    const current = await new SoftwareUpdateService(version, [
      new JsonFeedUpdateProvider('gitee', giteeFeedUrl),
      new JsonFeedUpdateProvider('github', githubFeedUrl)
    ]).check(new Date('2026-08-10T15:20:00.000Z'))
    const older = await new SoftwareUpdateService('0.9.0', [
      new JsonFeedUpdateProvider('gitee', giteeFeedUrl),
      new JsonFeedUpdateProvider('github', githubFeedUrl)
    ]).check(new Date('2026-08-10T15:20:00.000Z'))
    const fallback = await new SoftwareUpdateService('0.9.0', [
      new JsonFeedUpdateProvider('unreachable', 'https://127.0.0.1:1/latest.json'),
      new JsonFeedUpdateProvider('github', githubFeedUrl)
    ], 3_000).check(new Date('2026-08-10T15:20:00.000Z'))

    expect(current).toMatchObject({
      outcome: 'up_to_date',
      latestVersion: version
    })
    expect(older).toMatchObject({
      outcome: 'update_available',
      latestVersion: version,
      releaseUrl: releaseUrls.gitee
    })
    expect(fallback).toMatchObject({
      outcome: 'update_available',
      latestVersion: version,
      releaseUrl: releaseUrls.github
    })
  }, 30_000)
})
