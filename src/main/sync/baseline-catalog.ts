import type { GameId } from '../../shared/contracts'
import type { CodexVersionWindow, NormalizedSyncItem } from './types'

export const BUNDLED_BASELINE_VERIFIED_AT = '2026-08-12T18:20:00+08:00'

// These are per-game fallback cadences, not claims about a fixed official
// schedule. Exact verified windows always take priority; the cadence is only
// used after a stored window expires before the next calibration arrives.
const DEFAULT_VERSION_CADENCE_DAYS: Record<GameId, number> = {
  genshin: 42,
  'star-rail': 42,
  zenless: 42,
  'wuthering-waves': 42
}

const VERSION_WINDOWS: Record<GameId, CodexVersionWindow> = {
  genshin: {
    periodKey: 'genshin-version-7.0-2026',
    startsAt: '2026-08-12T11:00:00+08:00',
    endsAt: '2026-09-23T05:59:00+08:00',
    timeZone: 'Asia/Shanghai',
    sourceUrl: 'https://ys.mihoyo.com/main/news/detail/165682',
    confidence: 0.82
  },
  'star-rail': {
    periodKey: 'version-4.4',
    startsAt: '2026-07-15T06:00:00+08:00',
    endsAt: '2026-08-26T06:00:00+08:00',
    timeZone: 'Asia/Shanghai',
    sourceUrl: 'https://sr.mihoyo.com/news?nav=news&type=activity',
    confidence: 1
  },
  zenless: {
    periodKey: '3.1',
    startsAt: '2026-07-29T06:00:00+08:00',
    endsAt: '2026-09-09T06:00:00+08:00',
    timeZone: 'Asia/Shanghai',
    sourceUrl: 'https://zenless.hoyoverse.com/zh-cn/news',
    confidence: 1
  },
  'wuthering-waves': {
    periodKey: 'wuthering-waves:version:3.5',
    startsAt: '2026-07-10T11:00:00+08:00',
    endsAt: '2026-08-20T04:00:00+08:00',
    timeZone: 'Asia/Shanghai',
    sourceUrl: 'https://wutheringwaves.kurogames.com/main/news/detail/5023',
    confidence: 1
  }
}

type ActivitySeed = Omit<NormalizedSyncItem, 'category'>

const GENSHIN_70_ACTIVITY_DIGEST = 'https://ys.mihoyo.com/main/news/detail/165630'
const GENSHIN_70_SPROUT_EVENT = 'https://ys.mihoyo.com/main/news/detail/165629'
const GENSHIN_70_FORGE_REALM = 'https://ys.mihoyo.com/main/news/detail/165634'
const GENSHIN_SEASONAL_TRAINING = 'https://ys.mihoyo.com/main/news/detail/165613'
const GENSHIN_70_WEB_EVENT = 'https://ys.mihoyo.com/main/news/detail/165696'
const STAR_RAIL_NEWS = 'https://sr.mihoyo.com/news?nav=news&type=activity'
const ZENLESS_NEWS = 'https://zenless.hoyoverse.com/zh-cn/news'
const WUTHERING_WAVES_35 = 'https://wutheringwaves.kurogames.com/main/news/detail/5023'

const ACTIVITIES: Record<GameId, readonly ActivitySeed[]> = {
  genshin: [
    { remoteKey: 'event:7.0:seasonal-training', title: '砺行修远', activityTags: ['quest', 'material-reward'], startsAt: '2026-08-10T04:00:00+08:00', endsAt: '2026-11-02T03:59:59+08:00', sourceUrl: GENSHIN_SEASONAL_TRAINING },
    { remoteKey: 'event:7.0:sprout-mutual-aid-snowfield', title: '新芽相助·初探雪原', activityTags: ['exploration', 'photography', 'collection'], startsAt: '2026-08-12T11:00:00+08:00', endsAt: '2026-08-24T03:59:59+08:00', sourceUrl: GENSHIN_70_SPROUT_EVENT },
    { remoteKey: 'event:7.0:forge-realm-strategic-battle', title: '铸境研炼·奕思巧战', activityTags: ['card', 'challenge'], startsAt: '2026-08-12T11:00:00+08:00', endsAt: '2026-09-23T05:59:00+08:00', sourceUrl: GENSHIN_70_FORGE_REALM },
    { remoteKey: 'event:7.0:frontier-challenger-championship', title: '险境征者争锋大赛', activityTags: ['racing', 'shooting', 'combat', 'challenge'], startsAt: '2026-08-28T10:00:00+08:00', endsAt: '2026-09-14T03:59:59+08:00', sourceUrl: GENSHIN_70_ACTIVITY_DIGEST },
    { remoteKey: 'web-event:7.0:snezhnaya-travel-handbook', title: '至冬漫游手册', activityTags: ['web-event', 'quest'], startsAt: '2026-08-12T14:00:00+08:00', endsAt: '2026-08-25T23:59:59+08:00', sourceUrl: GENSHIN_70_WEB_EVENT }
  ],
  'star-rail': [
    { remoteKey: 'event:4.4:anti-corruption', title: '反贪「砖」家', activityTags: ['puzzle', 'challenge', 'co-op'], startsAt: '2026-07-15T11:00:00+08:00', endsAt: '2026-08-26T03:59:59+08:00', sourceUrl: STAR_RAIL_NEWS },
    { remoteKey: 'event:4.4:gift-of-odyssey', title: '巡星之礼', activityTags: ['sign-in'], startsAt: '2026-07-15T11:00:00+08:00', endsAt: '2026-08-25T03:59:59+08:00', sourceUrl: STAR_RAIL_NEWS },
    { remoteKey: 'event:4.4:fate-contract', title: '命运契约•再启', activityTags: ['sign-in'], startsAt: '2026-07-24T12:00:00+08:00', endsAt: '2026-11-11T06:59:59+08:00', sourceUrl: STAR_RAIL_NEWS },
    { remoteKey: 'event:4.4:holy-grail-war', title: '命运/银河铁道之夜', activityTags: ['card', 'tactics', 'story'], startsAt: '2026-07-24T12:00:00+08:00', endsAt: '2026-08-26T03:59:59+08:00', sourceUrl: STAR_RAIL_NEWS },
    { remoteKey: 'event:4.4:planar-fissure', title: '位面分裂', activityTags: ['combat', 'double-reward'], startsAt: '2026-07-27T04:00:00+08:00', endsAt: '2026-08-10T03:59:59+08:00', sourceUrl: STAR_RAIL_NEWS },
    { remoteKey: 'event:4.4:garden-of-plenty', title: '花藏繁生', activityTags: ['combat', 'double-reward', 'material-reward'], startsAt: '2026-08-14T04:00:00+08:00', endsAt: '2026-08-24T03:59:59+08:00', sourceUrl: STAR_RAIL_NEWS }
  ],
  zenless: [
    { remoteKey: 'event:3.1:summer-waves', title: '恰浪花逐夏而至', activityTags: ['management', 'collection', 'story'], startsAt: '2026-07-29T11:00:00+08:00', endsAt: '2026-09-07T03:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:phaethon-yearbook', title: '法厄同年度大揭秘', activityTags: ['story'], startsAt: '2026-07-29T11:00:00+08:00', endsAt: '2026-09-09T05:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:marcel-anniversary', title: '玛瑟尔周年馈礼', activityTags: ['sign-in'], startsAt: '2026-07-29T11:00:00+08:00', endsAt: '2026-09-09T05:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:hunting-game', title: '潜能预演·狩猎游戏', activityTags: ['combat', 'challenge'], startsAt: '2026-07-29T11:00:00+08:00', endsAt: '2026-09-09T05:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:cloud-gift', title: '云端赠礼', activityTags: ['sign-in'], startsAt: '2026-07-29T11:00:00+08:00', endsAt: '2026-09-08T03:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:return-to-ridu', title: '回归丽都 羽落重逢', activityTags: ['web-event'], startsAt: '2026-07-17T20:30:00+08:00', endsAt: '2026-09-09T05:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:focus-duel', title: '咔嚓！焦点对决！', activityTags: ['photography', 'combat'], startsAt: '2026-08-07T10:00:00+08:00', endsAt: '2026-08-24T03:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:deep-patrol-triple', title: '深度巡防-三倍赏金', activityTags: ['combat', 'double-reward', 'material-reward'], startsAt: '2026-08-12T04:00:00+08:00', endsAt: '2026-08-17T03:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:bangboo-delivery', title: '「嗯呢」大派送！', activityTags: ['sign-in'], startsAt: '2026-08-19T10:00:00+08:00', endsAt: '2026-09-08T03:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:crispy-meal-plan', title: '咔滋酥脆出餐计划', activityTags: ['management', 'simulation'], startsAt: '2026-08-19T10:00:00+08:00', endsAt: '2026-09-07T03:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:most-wanted-holiday', title: '极危通缉与悠游假期', activityTags: ['photography', 'exploration'], startsAt: '2026-08-24T10:00:00+08:00', endsAt: '2026-09-07T03:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:trainee-courier', title: '叮咚！见习邮差派件中', activityTags: ['quest'], startsAt: '2026-08-28T10:00:00+08:00', endsAt: '2026-09-14T03:59:59+08:00', sourceUrl: ZENLESS_NEWS },
    { remoteKey: 'event:3.1:combat-training-triple', title: '实战特训-三倍悬赏', activityTags: ['combat', 'double-reward', 'material-reward'], startsAt: '2026-09-02T04:00:00+08:00', endsAt: '2026-09-07T03:59:59+08:00', sourceUrl: ZENLESS_NEWS }
  ],
  'wuthering-waves': [
    { remoteKey: 'ww:event:3.5:yuyin-zengli', title: '余音赠礼', activityTags: ['sign-in'], startsAt: '2026-07-10T11:00:00+08:00', endsAt: '2026-08-19T03:59:00+08:00', sourceUrl: WUTHERING_WAVES_35 },
    { remoteKey: 'ww:event:3.5:yilv-zengli', title: '忆旅赠礼', activityTags: ['sign-in'], startsAt: '2026-07-10T11:00:00+08:00', endsAt: '2026-08-19T11:59:00+08:00', sourceUrl: WUTHERING_WAVES_35 },
    { remoteKey: 'ww:event:3.5:cixi-xuanfang', title: '此隙玄方', activityTags: ['exploration', 'collection', 'quest'], startsAt: '2026-07-10T11:00:00+08:00', endsAt: '2026-08-19T03:59:00+08:00', sourceUrl: WUTHERING_WAVES_35 },
    { remoteKey: 'ww:event:3.5:beiming-xingdong-wuyin-weiji', title: '悲鸣行动：无音危机', activityTags: ['combat', 'challenge'], startsAt: '2026-07-11T10:00:00+08:00', endsAt: '2026-08-19T11:59:00+08:00', sourceUrl: WUTHERING_WAVES_35 },
    { remoteKey: 'ww:web-event:3.5:miyu-xunzongji', title: '秘玉寻踪记', activityTags: ['web-event', 'parkour'], startsAt: '2026-07-30T10:00:00+08:00', endsAt: '2026-08-13T10:00:00+08:00', sourceUrl: WUTHERING_WAVES_35 },
    { remoteKey: 'ww:event:3.5:xuyu-weiju-xiangxian-yanzhan', title: '虚域危局・象限延展', activityTags: ['combat', 'challenge'], startsAt: '2026-07-30T10:00:00+08:00', endsAt: '2026-08-19T03:59:00+08:00', sourceUrl: WUTHERING_WAVES_35 },
    { remoteKey: 'ww:event:3.5:wuwu-qihua-xinlv', title: '呜呜企划・新旅', activityTags: ['quest', 'exploration'], startsAt: '2026-08-06T04:00:00+08:00', endsAt: '2026-08-19T03:59:00+08:00', sourceUrl: WUTHERING_WAVES_35 },
    { remoteKey: 'ww:event:shengxian-didang:2026-08-12', title: '声弦涤荡', activityTags: ['double-reward', 'material-reward'], startsAt: '2026-08-12T04:00:00+08:00', endsAt: '2026-08-19T03:59:00+08:00', sourceUrl: WUTHERING_WAVES_35 }
  ]
}

export function getBundledVersionWindow(gameId: GameId): CodexVersionWindow {
  return { ...VERSION_WINDOWS[gameId] }
}

export function getDefaultVersionCadenceDays(gameId: GameId): number {
  return DEFAULT_VERSION_CADENCE_DAYS[gameId]
}

export function getBundledActivityCatalog(gameId: GameId): NormalizedSyncItem[] {
  return ACTIVITIES[gameId].map((item) => ({
    ...item,
    category: 'limited_event' as const,
    completed: false,
    scheduleKind: 'fixed_window' as const
  }))
}
