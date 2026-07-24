import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {}
}))

import { buildVerificationPage } from '../src/main/auth/miyoushe-geetest-window'

describe('Geetest verification page', () => {
  it('forces HTTPS when the isolated page uses a data URL', () => {
    const html = buildVerificationPage(
      {
        gt: 'ec4aa4174277d822d73f2442a165a2cd',
        riskType: '',
        sessionId: '',
        version: 4
      },
      {
        title: '库街区安全验证',
        heading: '库街区安全验证',
        description: '测试',
        includeSessionUserInfo: false,
        showMethod: 'showBox'
      }
    )

    expect(html).toContain('https: true')
    expect(html).toContain('challenge.riskType ? { riskType: challenge.riskType } : {}')
    expect(html).toContain('验证组件已加载，正在连接官方验证服务')
    expect(html).toContain('官方验证服务初始化超时')
  })
})
