import { describe, expect, it } from 'vitest'
import {
  extractWutheringWavesExplorationReviewCandidates,
  parseWutheringWavesExploration,
  parseWutheringWavesMatrix,
  parseWutheringWavesPersonalData,
  parseWutheringWavesSlash,
  parseWutheringWavesTower
} from '../src/main/sync/wuthering-waves-personal-parser'
import { WutheringWavesPersonalAdapter } from '../src/main/sync/wuthering-waves-personal-adapter'

describe('鸣潮个人进度解析', () => {
  it('保留一级主地区和二级地区探索度', () => {
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
    })).toEqual(expect.arrayContaining([
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
        progressPercent: 100
      }),
      expect.objectContaining({
        remoteKey: 'exploration:area:102',
        title: '黑海岸',
        parentTitle: '瑝珑',
        progressPercent: 63
      })
    ]))
  })

  it('地图语义候选同时发送一级主地区和二级地区', () => {
    const candidates = extractWutheringWavesExplorationReviewCandidates({
      exploreList: [{
        country: { countryId: 1, countryName: '瑝珑' },
        countryProgress: 78.4,
        areaInfoList: [
          { areaId: 101, areaName: '乘霄山', areaProgress: 100 }
        ]
      }]
    })

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          officialId: '1',
          officialTitle: '瑝珑',
          observedNodeKind: 'region',
          observedProgress: 78.4
        })
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          officialId: 'area:101',
          officialTitle: '乘霄山',
          observedNodeKind: 'subregion',
          observedParentTitle: '瑝珑',
          observedProgress: 100
        })
      })
    ]))
  })

  it('挑战模式只要存在本期挑战记录就判定完成，不要求满星或满分', () => {
    expect(parseWutheringWavesTower({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{
        towerAreaList: [{ star: 0, floorList: [{ floor: 1, star: 0, hasRecord: true }] }]
      }]
    })).toMatchObject({
      title: '逆境深塔',
      completed: true,
      startsAt: null,
      endsAt: null,
      modeKey: 'tower-of-adversity'
    })

    expect(parseWutheringWavesSlash({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{
        allScore: 0,
        challengeList: [{ score: 1, halfList: [] }]
      }]
    })).toMatchObject({
      title: '冥歌海墟',
      completed: true,
      startsAt: null,
      endsAt: null
    })

    expect(parseWutheringWavesMatrix({
      isUnlock: true,
      endTime: 1787183999,
      modeDetails: [{ hasRecord: true, score: 0, teams: [] }]
    })).toMatchObject({
      title: '终焉矩阵',
      completed: true,
      startsAt: null,
      endsAt: null,
      periodKey: 'wuthering-waves:endstate-matrix:current'
    })
  })

  it('完全没有碰过挑战时保持未完成', () => {
    expect(parseWutheringWavesTower({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{ towerAreaList: [{ star: 0, floorList: [{ floor: 1, star: 0 }] }] }]
    })).toMatchObject({ completed: false })
    expect(parseWutheringWavesSlash({
      isUnlock: true,
      seasonEndTime: 1787183999,
      difficultyList: [{
        allScore: 0,
        challengeList: [{ score: 0, halfList: [{ half: 1, score: 0 }] }]
      }]
    })).toMatchObject({ completed: false })
    expect(parseWutheringWavesMatrix({
      isUnlock: true,
      endTime: 1787183999,
      modeDetails: [{ hasRecord: false, score: 0, passBoss: 0, teams: [{ roleIds: [] }] }]
    })).toMatchObject({ completed: false })
  })

  it('适配器按版块请求数据并保留部分成功结果', async () => {
    const order: string[] = []
    const progress: Array<{ message: string; current?: number | null; total?: number | null }> = []
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

    const output = await adapter.sync(
      'wuthering-waves',
      'cycles',
      (update) => progress.push(update)
    )
    expect(order).toEqual(['tower', 'slash', 'matrix'])
    expect(output.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'endgame', modeKey: 'tower-of-adversity' }),
      expect.objectContaining({ category: 'endgame', modeKey: 'endstate-matrix' })
    ]))
    expect(output.snapshotCompleteness).toBe('partial')
    expect(output.message).toContain('部分成功 2/3')
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: '正在读取逆境深塔战绩', current: 1, total: 3 }),
      expect.objectContaining({ message: '冥歌海墟战绩读取失败，继续下一项', current: 2, total: 3 }),
      expect.objectContaining({ message: '正在读取终焉矩阵战绩', current: 3, total: 3 })
    ]))
    await expect(adapter.sync('genshin')).rejects.toThrow('不能用于其他游戏')
  })

  it('拒绝完全无法识别的个人数据', () => {
    expect(() => parseWutheringWavesPersonalData({})).toThrow('没有可识别')
  })
})
