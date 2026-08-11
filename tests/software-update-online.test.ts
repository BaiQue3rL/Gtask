import { describe, expect, it } from 'vitest'
import {
  JsonFeedUpdateProvider,
  SoftwareUpdateService
} from '../src/main/software-update'

const onlineIt = process.env.GTASK_ONLINE_RELEASE_TEST === '1' ? it : it.skip
const giteeFeedUrl = 'https://gitee.com/l3rui/Gtask/raw/main/updates/latest.json'
const githubFeedUrl = 'https://raw.githubusercontent.com/BaiQue3rL/Gtask/main/updates/latest.json'

describe('published software update feed', () => {
  onlineIt('prefers Gitee and falls back to the authoritative GitHub feed', async () => {
    const current = await new SoftwareUpdateService('1.0.0', [
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
      latestVersion: '1.0.0'
    })
    expect(older).toMatchObject({
      outcome: 'update_available',
      latestVersion: '1.0.0',
      releaseUrl: 'https://gitee.com/l3rui/Gtask/releases/tag/v1.0.0'
    })
    expect(fallback).toMatchObject({
      outcome: 'update_available',
      latestVersion: '1.0.0',
      releaseUrl: 'https://github.com/BaiQue3rL/Gtask/releases/tag/v1.0.0'
    })
  }, 30_000)
})
