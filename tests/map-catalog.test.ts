import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  getBundledMapCatalog,
  getBundledMapCatalogCounts,
  getBundledMapCatalogVerifiedAt
} from '../src/main/sync/map-catalog'
import { SUPPORTED_GAME_IDS } from '../src/shared/contracts'

describe('bundled map catalog', () => {
  it('uses exactly two levels and gives every second-level region one valid parent', () => {
    for (const gameId of SUPPORTED_GAME_IDS) {
      const catalog = getBundledMapCatalog(gameId)
      const regions = catalog.filter((item) => item.mapNodeKind === 'region')
      const subregions = catalog.filter((item) => item.mapNodeKind === 'subregion')
      const regionKeys = new Set(regions.map((item) => item.remoteKey))
      const semanticIdentities = new Set(catalog.map((item) =>
        `${item.mapNodeKind}:${item.parentRemoteKey ?? 'root'}:${item.title.normalize('NFKC')}`
      ))

      expect(regions.length).toBeGreaterThan(0)
      expect(catalog).toHaveLength(new Set(catalog.map((item) => item.remoteKey)).size)
      expect(catalog).toHaveLength(semanticIdentities.size)
      expect(regions.every((item) =>
        item.parentRemoteKey === null && item.parentTitle === null
      )).toBe(true)
      expect(subregions.every((item) =>
        typeof item.parentRemoteKey === 'string' &&
        regionKeys.has(item.parentRemoteKey) &&
        typeof item.parentTitle === 'string'
      )).toBe(true)
      expect(getBundledMapCatalogCounts(gameId)).toEqual({
        regions: regions.length,
        subregions: subregions.length
      })
    }
  })

  it('keeps stable machine identities between reads', () => {
    for (const gameId of SUPPORTED_GAME_IDS) {
      expect(getBundledMapCatalog(gameId)).toEqual(getBundledMapCatalog(gameId))
      expect(Number.isNaN(Date.parse(getBundledMapCatalogVerifiedAt(gameId)))).toBe(false)
    }
  })

  it('corrects reviewed display names without changing shipped RC30 identities', () => {
    const expectedLegacyKey = (
      gameId: 'genshin' | 'wuthering-waves',
      identity: string
    ) => `map-catalog:${gameId}:subregion:${createHash('sha256')
      .update(`${gameId}\0subregion\0${identity}`, 'utf8')
      .digest('hex')
      .slice(0, 20)}`

    const genshin = getBundledMapCatalog('genshin')
    expect(genshin.find((item) => item.title === '月荡海')?.remoteKey).toBe(
      expectedLegacyKey('genshin', '挪德卡莱\0月落海')
    )
    expect(genshin.find((item) => item.title === '烟硌山峰')?.remoteKey).toBe(
      expectedLegacyKey('genshin', '挪德卡莱\0烟硙山峰')
    )
    expect(genshin.some((item) => ['月落海', '烟硙山峰'].includes(item.title))).toBe(false)

    const wutheringWaves = getBundledMapCatalog('wuthering-waves')
    expect(wutheringWaves.find((item) => item.title === '盲望之塌')?.remoteKey).toBe(
      expectedLegacyKey('wuthering-waves', '罗伊冰原\0盲望之塬')
    )
    expect(wutheringWaves.some((item) => item.title === '盲望之塬')).toBe(false)
  })

  it('keeps the reviewed first-level catalog and representative parent bindings', () => {
    const rootTitles = (gameId: (typeof SUPPORTED_GAME_IDS)[number]) =>
      getBundledMapCatalog(gameId)
        .filter((item) => item.mapNodeKind === 'region')
        .map((item) => item.title)

    expect(rootTitles('genshin')).toEqual([
      '空之神殿',
      '挪德卡莱',
      '纳塔',
      '枫丹',
      '须弥',
      '稻妻',
      '璃月',
      '蒙德'
    ])
    expect(rootTitles('wuthering-waves')).toEqual([
      '瑝珑',
      '黑海岸',
      '黎那汐塔',
      '罗伊冰原'
    ])
    expect(rootTitles('zenless')).toEqual([
      '罗斯凯利法',
      '斯卡莫空洞',
      '卫非地',
      '莱姆尼安空洞',
      '雅努斯区',
      '外环地带'
    ])
    expect(rootTitles('star-rail')).toEqual([
      '空间站「黑塔」',
      '雅利洛-Ⅵ',
      '仙舟「罗浮」',
      '匹诺康尼',
      '翁法罗斯',
      '二相乐园',
      '星穹列车'
    ])

    const representativeChildren = getBundledMapCatalog('genshin').filter(
      (item) => ['沉玉谷', '层岩巨渊·地下矿区', '渊下宫'].includes(item.title)
    )
    expect(representativeChildren).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '沉玉谷',
        parentTitle: '璃月',
        mapNodeKind: 'subregion'
      }),
      expect.objectContaining({
        title: '层岩巨渊·地下矿区',
        parentTitle: '璃月',
        mapNodeKind: 'subregion'
      }),
      expect.objectContaining({
        title: '渊下宫',
        parentTitle: '稻妻',
        mapNodeKind: 'subregion'
      })
    ]))
  })
})
