import { describe, expect, it } from 'vitest'
import {
  parseWutheringWavesExploration,
  parseWutheringWavesMatrix,
  parseWutheringWavesPersonalData,
  parseWutheringWavesSlash,
  parseWutheringWavesTower
} from '../src/main/sync/wuthering-waves-personal-parser'
import { WutheringWavesPersonalAdapter } from '../src/main/sync/wuthering-waves-personal-adapter'

describe('鸣潮个人进度解析', () => {
  it('同时保留大区域和独立子区域探索度', () => {
    expect(parseWutheringWavesExploration({
      open: true,
      exploreList: [{
        country: { countryId: 1, countryName: '瑝珑' },
        countryProgress: '78.4',
        areaInfoList: [
          { areaId: 101, areaName: '乘霄山', areaProgress: 100, itemList: [] },
          { areaId: 102, areaName: '黑海岸', areaProgress: 63, itemList: [] }
        ]
      }]
    })).toEqual([
      expect.objectContaining({
        remoteKey: 'exploration:country:1',
        title: '瑝珑',
        progressPercent: 78.4,
        completed: false
      }),
      expect.objectContaining({
        remoteKey: 'exploration:area:101',
        title: '乘霄山',
        parentTitle: '瑝珑',
        progressPercent: 100,
        completed: true
      }),
      expect.objectContaining({
        remoteKey: 'exploration:area:102',
        title: '黑海岸',
        progressPercent: 63
      })
    ])
  })

  it('挑战模式只要存在本期挑战记录就判定完成，不要求满星或满分', () => {
    expect(parseWutheringWavesTower({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{
        towerAreaList: [{ star: 0, floorList: [{ floor: 1, star: 0 }] }]
      }]
    })).toMatchObject({
      title: '逆境深塔',
      completed: true,
      endsAt: '2026-08-19T23:59:59.000Z',
      modeKey: 'tower'
    })

    expect(parseWutheringWavesSlash({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{
        allScore: 0,
        challengeList: [{ score: 1, halfList: [] }]
      }]
    })).toMatchObject({ title: '冥歌海墟', completed: true })

    expect(parseWutheringWavesMatrix({
      isUnlock: true,
      endTime: 1787183999,
      modeDetails: [{ hasRecord: true, score: 0, teams: [] }]
    })).toMatchObject({ title: '终焉矩阵', completed: true })
  })

  it('完全没有碰过挑战时保持未完成', () => {
    expect(parseWutheringWavesTower({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{ towerAreaList: [{ star: 0, floorList: [] }] }]
    })).toMatchObject({ completed: false })
    expect(parseWutheringWavesSlash({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{ allScore: 0, challengeList: [{ score: 0, halfList: [] }] }]
    })).toMatchObject({ completed: false })
    expect(parseWutheringWavesMatrix({
      isUnlock: true,
      endTime: 1787183999,
      modeDetails: [{ hasRecord: false, score: 0, passBoss: 0, teams: [] }]
    })).toMatchObject({ completed: false })
  })

  it('适配器按版块请求数据并保留部分成功结果', async () => {
    const order: string[] = []
    const adapter = new WutheringWavesPersonalAdapter({
      getExploration: async () => {
        order.push('exploration')
        return { open: true, exploreList: [] }
      },
      getTower: async () => {
        order.push('tower')
        return { seasonEndTime: 1787183999, difficultyList: [] }
      },
      getSlash: async () => {
        order.push('slash')
        throw new Error('接口暂时失败')
      },
      getMatrix: async () => {
        order.push('matrix')
        return { endTime: 1787183999, modeDetails: [] }
      }
    })

    const output = await adapter.sync('wuthering-waves', 'cycles')
    expect(order).toEqual(['tower', 'slash', 'matrix'])
    expect(output.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modeKey: 'tower' }),
      expect.objectContaining({ modeKey: 'matrix' })
    ]))
    expect(output.message).toContain('部分成功 2/3')
    await expect(adapter.sync('genshin')).rejects.toThrow('不能用于其他游戏')
  })

  it('拒绝完全无法识别的个人数据', () => {
    expect(() => parseWutheringWavesPersonalData({})).toThrow('没有可识别')
  })
})
