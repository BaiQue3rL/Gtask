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
    expect(app).toContain('<span>同步进度</span>')
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

  it('uses compact grouped list rows without category or source chips', () => {
    expect(app).toContain('class="item-identity"')
    expect(app).not.toContain('class="item-details"')
    expect(app).not.toContain('class="source-detail"')
    expect(styles).toContain('min-height: 48px')
    expect(styles).toContain('.checklist-row + .checklist-row')
    expect(styles).toContain('.activity-tag {')
  })

  it('renders the incomplete filter as an accessible stateful switch', () => {
    expect(app).toContain('v-model="showIncompleteOnly"')
    expect(app).toContain('class="incomplete-filter-control"')
    expect(app).toContain('class="incomplete-filter-label"')
    expect(app).not.toContain(':class="{ active: showIncompleteOnly }"')
    expect(styles).not.toContain('.incomplete-filter-button.active')
    expect(styles).toContain('transform: translateX(14px)')
    expect(styles).toMatch(/\.incomplete-filter-label \{[^}]*font-size: 13px[^}]*font-weight: 500/)
    expect(styles).toMatch(/\.incomplete-filter-control \{[^}]*min-height: var\(--control-height\)/)
  })

  it('aligns the incomplete filter with the selected game heading', () => {
    expect(app).toContain('class="page-heading"')
    expect(app).toContain('class="page-game-icon"')
    expect(app).toContain('class="page-version-remaining"')
    expect(styles).toMatch(/\.topbar \{[^}]*display: flex[^}]*align-items: center[^}]*justify-content: space-between/)
    expect(styles).toMatch(/\.topbar, \.checklist-content-frame, \.error-banner \{[^}]*width: min\(100%, 920px\)/)
    expect(styles).toMatch(/h1 \{[^}]*font-size: 22px[^}]*line-height: 1\.25/)
  })

  it('keeps footer metadata with aligned sidebar actions and preserves the narrow filter label', () => {
    expect(app).toContain('class="sidebar-meta"')
    expect(app).not.toContain('class="dev-footer"')
    expect(styles).toContain('grid-template-columns: 18px minmax(0, 1fr)')
    expect(styles).not.toMatch(/\.incomplete-filter-label \{\s*display: none/)
    expect(styles).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.app-shell \{ grid-template-columns: 72px minmax\(0, 1fr\)/)
  })

  it('does not render the unused checklist summary board', () => {
    expect(app).not.toContain('class="summary-grid"')
    expect(app).not.toContain('incompleteCount')
    expect(app).not.toContain('expiringCount')
    expect(app).not.toContain('completedCount')
    expect(styles).not.toContain('.summary-grid')
    expect(styles).not.toContain('.summary-card')
    expect(styles).not.toContain('.summary-icon')
  })

  it('uses the shared compact switch treatment for every settings toggle', () => {
    expect(app.match(/class="toggle-switch-input"/g)).toHaveLength(5)
    expect(styles).toContain('.toggle-switch-input:checked + .toggle-switch')
    expect(styles).toMatch(/\.game-preference-row \{[^}]*min-height: 46px/)
    expect(styles).toMatch(/\.preference-toggle \{[^}]*display: flex !important[^}]*justify-content: center/)
  })

  it('keeps the settings frame stable while switching categories', () => {
    expect(app).not.toContain('settings-modal-compact')
    expect(styles).not.toContain('.settings-modal.settings-modal-compact')
    expect(styles).toMatch(/\.settings-modal \{[^}]*height: min\(680px, calc\(100vh - 48px\)\)/)
  })

  it('aligns settings actions to a shared right-side column', () => {
    expect(styles).toMatch(/\.credential-actions, \.data-location-actions, \.software-update-actions \{[^}]*width: 190px[^}]*flex: 0 0 190px/)
    expect(styles).toMatch(/\.backup-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto 190px/)
    expect(styles).toMatch(/\.backup-row button \{[^}]*width: 91px[^}]*margin-right: -8px[^}]*justify-self: end/)
    expect(styles).toMatch(/\.backup-list \{[^}]*scrollbar-gutter: stable/)
    expect(styles).toMatch(/\.data-location > span \{[^}]*width: 100%[^}]*min-width: 0[^}]*text-overflow: ellipsis/)
    expect(styles).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.credential-actions, \.data-location-actions \{[^}]*align-self: flex-end[^}]*flex: 0 0 auto/)
    expect(styles).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.software-update-actions \{[^}]*width: 100%[^}]*flex: 0 0 auto/)
  })

  it('combines per-game preferences before the global item visibility setting', () => {
    const preferencesIndex = app.indexOf('<div class="game-preference-table">')
    const visibilityColumnIndex = app.indexOf('<span>游戏</span><span>显示</span><span>自动同步</span>')
    const itemVisibilityIndex = app.indexOf('<h3 class="settings-heading">显示还没开始的事项</h3>')
    const layoutIndex = app.indexOf('<h3 class="settings-heading">版块顺序</h3>')

    expect(preferencesIndex).toBeLessThan(visibilityColumnIndex)
    expect(visibilityColumnIndex).toBeLessThan(itemVisibilityIndex)
    expect(itemVisibilityIndex).toBeLessThan(layoutIndex)
  })

  it('uses a restrained semantic dark theme instead of decorative blue gradients', () => {
    expect(styles).toContain('--color-neutral-background-1:')
    expect(styles).toContain('--color-brand-background:')
    expect(styles).not.toContain('linear-gradient')
    expect(styles).not.toContain('radial-gradient')
    expect(app).not.toContain('class="overview')
    expect(styles).toMatch(/\.completed \.item-title \{[^}]*text-decoration: line-through/)
    expect(styles).not.toMatch(/\.checklist-row\.completed \{[^}]*background:/)
    expect(styles).toMatch(/\.game-version-remaining \{[^}]*color: var\(--color-info-muted\)/)
    expect(styles).toMatch(/\.item-timing \{[^}]*color: var\(--color-info-muted\)/)
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
