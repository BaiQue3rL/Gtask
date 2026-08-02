import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Windows installer directory', () => {
  it('treats a selected directory as the parent of the Gtask install folder', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as {
      build?: {
        electronLanguages?: string[]
        nsis?: {
          include?: string
          allowToChangeInstallationDirectory?: boolean
          createDesktopShortcut?: boolean
          runAfterFinish?: boolean
          deleteAppDataOnUninstall?: boolean
        }
      }
    }
    const installer = readFileSync(
      new URL('../build/installer.nsh', import.meta.url),
      'utf8'
    )

    expect(packageJson.build?.nsis?.include).toBe('build/installer.nsh')
    expect(packageJson.build?.nsis?.allowToChangeInstallationDirectory).toBe(false)
    expect(packageJson.build?.nsis?.createDesktopShortcut).toBe(false)
    expect(packageJson.build?.nsis?.runAfterFinish).toBe(true)
    expect(packageJson.build?.nsis?.deleteAppDataOnUninstall).toBe(false)
    expect(packageJson.build?.electronLanguages).toEqual(['en-US', 'zh-CN', 'zh-TW'])
    expect(installer).toContain('!macro EnsureGtaskInstallDirectory PATH_VAR SCRATCH_VAR')
    expect(installer).toContain('!macro customPageAfterChangeDir')
    expect(installer).toContain('Page custom GtaskDirectoryPageCreate GtaskDirectoryPageLeave')
    expect(installer).toContain('Function GtaskDirectoryBrowse')
    expect(installer).toContain('${NSD_SetText} $GtaskDirectoryInput "$0"')
    expect(installer).toContain('SendMessage $GtaskDirectoryInput ${EM_SETSEL} 0 0')
    expect(installer).toContain('StrCpy ${PATH_VAR} "${PATH_VAR}\\${APP_FILENAME}"')
    expect(installer).toContain('Function GtaskDirectoryPageLeave')
    expect(installer).toContain('ShowInstDetails show')
    expect(installer).toContain('Function GtaskRefreshInstallProgress')
    expect(installer).toContain('0x0407 1 0 $1')
    expect(installer).toContain('0x0408 0 0 $0')
    expect(installer).toContain('IntOp $3 $0 / 5')
    expect(installer).toContain('DetailPrint "安装进度：$3%"')
    expect(installer).toContain('正在解压程序文件')
    expect(installer).toContain('!macro customInstall')
    expect(installer).toContain('正在写入应用组件')
    expect(installer).toContain('程序文件安装完成')
    expect(installer).toContain('!macro customFinishPage')
    expect(installer).toContain('MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"')
    expect(installer).toContain('MUI_FINISHPAGE_RUN_TEXT "运行 Gtask"')
    expect(installer).toContain('Function GtaskCreateDesktopShortcut')
  })
})
