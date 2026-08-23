import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../src/renderer/src/App.vue', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

describe('product copy and built-in section boundaries', () => {
  it('does not expose maintenance-agent or public-source controls', () => {
    for (const obsoleteCopy of [
      'Codex',
      '同步公开数据',
      '切换数据来源',
      '建立你的第一份清单',
      '需要安装同步插件',
      '公开数据 AI'
    ]) {
      expect(app).not.toContain(obsoleteCopy)
    }
  })

  it('offers direct progress sync, direct login, and startup preferences', () => {
    expect(app).toContain('↻ 同步进度')
    expect(app).toContain('同步进度需要登录')
    expect(app).toContain('启动后自动同步')
    expect(app).toContain('saveAutoSyncPreference')
    expect(app).toContain('beginPendingPersonalLogin')
  })

  it('only renders personal-sync state for sections with a supported personal adapter', () => {
    expect(app.match(/v-if="panel\.syncTarget && personalSyncTargets\.includes\(panel\.syncTarget\)"/g))
      .toHaveLength(2)
  })

  it('only exposes creation and editing for the custom section', () => {
    expect(app).toContain('v-if="panel.allowCreate === true"')
    expect(app).toContain("v-if=\"panel.section === 'custom'\"")
    expect(app).toContain("if (section === 'custom') openEdit(item)")
    expect(app).toContain("if (item.category !== 'custom' || item.source !== 'manual') return")
  })

  it('uses compact single-line identity cards without category or source chips', () => {
    expect(app).toContain('class="item-identity"')
    expect(app).not.toContain('class="item-details"')
    expect(app).not.toContain('class="source-detail"')
    expect(styles).toContain('min-height: 50px')
    expect(styles).toContain('.item-identity .activity-tag')
  })

  it('renders the incomplete filter as an accessible stateful switch', () => {
    expect(app).toContain('v-model="showIncompleteOnly"')
    expect(app).toContain('class="incomplete-filter-control"')
    expect(app).toContain('class="incomplete-filter-label"')
    expect(app).not.toContain(':class="{ active: showIncompleteOnly }"')
    expect(styles).not.toContain('.incomplete-filter-button.active')
    expect(styles).toContain('transform: translateX(16px)')
    expect(styles).toMatch(/\.incomplete-filter-label \{[^}]*color: #f5f9ff[^}]*font-size: 15px[^}]*font-weight: 650/)
    expect(styles).toMatch(/\.incomplete-filter-control \{[^}]*justify-content: space-between/)
  })

  it('aligns the incomplete filter with the game title row', () => {
    expect(styles).toMatch(/\.topbar \{[^}]*align-items: end/)
    expect(styles).toMatch(/\.topbar \{[^}]*grid-template-columns: calc\(66\.6667% - 3px\)/)
    expect(styles).toMatch(/\.topbar-actions \{[^}]*align-self: end[^}]*\}/)
    expect(styles).not.toMatch(/\.topbar-actions \{[^}]*margin-right/)
    expect(styles).toMatch(/\.incomplete-filter-control \{[^}]*height: 36px/)
    expect(styles).toMatch(/h1 \{[^}]*line-height: 36px/)
  })

  it('uses the shared compact switch treatment for every settings toggle', () => {
    expect(app.match(/class="toggle-switch-input"/g)).toHaveLength(5)
    expect(styles).toContain('.toggle-switch-input:checked + .toggle-switch')
    expect(styles).toMatch(/\.editor-modal \.game-visibility-row \{[^}]*display: flex[^}]*min-height: 42px[^}]*margin-top: 0/)
  })

  it('keeps the global item visibility setting after both per-game toggle groups', () => {
    const gamesIndex = app.indexOf('<h3 class="settings-heading">我的游戏</h3>')
    const autoSyncIndex = app.indexOf('<h3 class="settings-heading">启动后自动同步</h3>')
    const itemVisibilityIndex = app.indexOf('<h3 class="settings-heading">显示内容</h3>')
    const layoutIndex = app.indexOf('<h3 class="settings-heading">版块顺序</h3>')

    expect(gamesIndex).toBeLessThan(autoSyncIndex)
    expect(autoSyncIndex).toBeLessThan(itemVisibilityIndex)
    expect(itemVisibilityIndex).toBeLessThan(layoutIndex)
  })

  it('keeps user-facing copy conversational and free of maintenance terms', () => {
    expect(app).toContain('显示还没开始的事项')
    expect(app).toContain('登录信息')
    expect(app).toContain('还没有备份')
    expect(app).toContain('>清除凭据</button>')
    expect(app).toContain('>打开目录</button>')
    expect(app).not.toContain('>清除登录信息</button>')
    expect(app).not.toContain('>打开数据文件夹</button>')
    for (const stiffCopy of [
      '显示尚未开始的基准事项',
      '登录凭据',
      '尚无备份',
      '该版块尚未同步',
      '界面渲染'
    ]) {
      expect(app).not.toContain(stiffCopy)
    }
  })

  it('keeps destructive checklist confirmations inside the themed renderer surface', () => {
    expect(app).toContain('class="prompt-modal confirmation-modal"')
    expect(app).toContain("title: '清空回收站'")
    expect(app).toContain("title: '删除已完成事项'")
    expect(app).not.toContain('window.confirm(`确定删除“${sectionTitle}')
    expect(styles).toContain('.confirmation-backdrop')
    expect(styles).toContain('.confirmation-danger-button')
    expect(main).not.toContain("title: '清空回收站'")
  })

  it('keeps repository selection inside the existing software update setting', () => {
    expect(app).toContain('更新来源')
    expect(app).toContain('自动（Gitee 优先）')
    expect(app).toContain('Gitee 镜像')
    expect(app).toContain('GitHub')
    expect(app).toContain('v-model="softwareUpdateSettings.updateSource"')
  })

  it('does not retain the removed activity tag filter implementation', () => {
    for (const obsoleteCode of [
      'activityTagFilter',
      'activityTagMenuOpen',
      'activityTagOptions',
      '玩法筛选',
      '全部玩法',
      'activity-tag-filter',
      'dropdown-menu'
    ]) {
      expect(app).not.toContain(obsoleteCode)
    }
    expect(styles).not.toContain('.activity-tag-filter')
    expect(styles).not.toContain('.activity-filter-')
    expect(styles).not.toContain('.dropdown-menu')
    expect(styles).not.toContain('.dropdown-chevron')
  })
})
