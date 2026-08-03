; Replace electron-builder's directory page with a Gtask-owned page. The
; selected folder is always treated as a parent, and the final directory is a
; visible, idempotent "Gtask" child folder.

!include "FileFunc.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  Var GtaskDirectoryDialog
  Var GtaskDirectoryInput
  Var GtaskDirectoryBrowseButton
!endif

!macro EnsureGtaskInstallDirectory PATH_VAR SCRATCH_VAR ROOT_VAR
  ${GetRoot} "${PATH_VAR}" ${ROOT_VAR}
  ${If} "${PATH_VAR}" != "${ROOT_VAR}"
    StrCpy ${SCRATCH_VAR} "${PATH_VAR}" 1 -1
    ${If} ${SCRATCH_VAR} == "\"
      StrCpy ${PATH_VAR} "${PATH_VAR}" -1
    ${EndIf}
  ${EndIf}

  ${GetFileName} "${PATH_VAR}" ${SCRATCH_VAR}
  ${If} ${SCRATCH_VAR} != "${APP_FILENAME}"
    ${If} "${PATH_VAR}" == "${ROOT_VAR}"
      StrCpy ${PATH_VAR} "${PATH_VAR}${APP_FILENAME}"
    ${Else}
      StrCpy ${PATH_VAR} "${PATH_VAR}\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom GtaskDirectoryPageCreate GtaskDirectoryPageLeave
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "运行 Gtask"
  !define MUI_FINISHPAGE_RUN_FUNCTION "GtaskStartApp"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "创建桌面快捷方式"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "GtaskCreateDesktopShortcut"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    SetDetailsPrint both
    DetailPrint "正在检查安装目录和现有版本…"
  !endif
!macroend

!macro customInstall
  SetDetailsPrint both
  DetailPrint "Gtask 安装完成"
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; Gtask's custom install section emits real operations into this pane.
    ShowInstDetails show

    Function GtaskDirectoryPageCreate
      !insertmacro MUI_HEADER_TEXT "选择安装位置" "选择 Gtask 要安装的文件夹。"

      nsDialogs::Create 1018
      Pop $GtaskDirectoryDialog
      ${If} $GtaskDirectoryDialog == error
        Abort
      ${EndIf}

      !insertmacro EnsureGtaskInstallDirectory $INSTDIR $0 $1

      ${NSD_CreateLabel} 0 0 100% 28u "请选择安装位置。选择父文件夹后，Gtask 会安装到其中的 Gtask 子文件夹。"
      Pop $0

      ${NSD_CreateGroupBox} 0 36u 100% 55u "目标文件夹"
      Pop $0

      ${NSD_CreateDirRequest} 10u 56u -78u 13u "$INSTDIR"
      Pop $GtaskDirectoryInput

      ${NSD_CreateBrowseButton} -68u 55u 58u 15u "浏览(B)..."
      Pop $GtaskDirectoryBrowseButton
      ${NSD_OnClick} $GtaskDirectoryBrowseButton GtaskDirectoryBrowse

      ${NSD_CreateLabel} 10u 73u -20u 10u "最终安装目录始终以 \Gtask 结尾。"
      Pop $0

      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
      SendMessage $GtaskDirectoryInput ${EM_SETSEL} 0 0
      ${NSD_SetFocus} $0

      nsDialogs::Show
    FunctionEnd

    Function GtaskDirectoryBrowse
      ${NSD_GetText} $GtaskDirectoryInput $0
      nsDialogs::SelectFolderDialog "选择 Gtask 的父文件夹" "$0"
      Pop $0
      ${If} $0 != error
        !insertmacro EnsureGtaskInstallDirectory $0 $1 $2
        ${NSD_SetText} $GtaskDirectoryInput "$0"
        StrCpy $INSTDIR "$0"
      ${EndIf}
    FunctionEnd

    Function GtaskDirectoryPageLeave
      ${NSD_GetText} $GtaskDirectoryInput $0
      ${If} $0 == ""
        MessageBox MB_ICONEXCLAMATION|MB_OK "请选择安装位置。"
        Abort
      ${EndIf}

      !insertmacro EnsureGtaskInstallDirectory $0 $1 $2
      StrCpy $INSTDIR "$0"
    FunctionEnd

    Function GtaskStartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    Function GtaskCreateDesktopShortcut
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    FunctionEnd
  !endif
!macroend
