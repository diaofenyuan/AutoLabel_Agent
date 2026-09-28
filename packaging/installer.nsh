!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!ifndef BUILD_UNINSTALLER

Var AutoLabelShortcutCheckbox
Var AutoLabelShortcutChoice

!macro customInit
  ; 静默部署（/S）不会显示自定义页面，这里允许显式指定是否创建桌面快捷方式：
  ;   AutoLabel-Setup.exe /S /NoDesktopShortcut   不创建（并清理已有桌面链接）
  ;   AutoLabel-Setup.exe /S /DesktopShortcut     创建
  ; 交互安装时页面上的复选框始终覆盖此处的取值。
  ${GetParameters} $R9
  ${GetOptions} $R9 "/NoDesktopShortcut" $R8
  ${IfNot} ${Errors}
    StrCpy $AutoLabelShortcutChoice 0
  ${EndIf}
  ${GetOptions} $R9 "/DesktopShortcut" $R8
  ${IfNot} ${Errors}
    StrCpy $AutoLabelShortcutChoice 1
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom AutoLabelShortcutPage AutoLabelShortcutPageLeave

Function AutoLabelShortcutPage
  ${If} ${isUpdated}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "快捷方式" "选择是否在桌面创建自动标注小助手快捷方式。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 10u 100% 32u "程序将安装到您选择的目录。项目、配置与凭据保存在安装目录，卸载时会迁移到当前用户目录保留。"
  Pop $0
  ${NSD_CreateCheckbox} 0 55u 100% 14u "创建桌面快捷方式"
  Pop $AutoLabelShortcutCheckbox
  ClearErrors
  ReadRegDWORD $AutoLabelShortcutChoice SHCTX "${INSTALL_REGISTRY_KEY}" "DesktopShortcut"
  ${If} ${Errors}
    StrCpy $AutoLabelShortcutChoice 1
  ${EndIf}
  ${If} $AutoLabelShortcutChoice == 1
    ${NSD_Check} $AutoLabelShortcutCheckbox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function AutoLabelShortcutPageLeave
  ${NSD_GetState} $AutoLabelShortcutCheckbox $AutoLabelShortcutChoice
FunctionEnd
!macroend

!macro customInstall
  ${If} $AutoLabelShortcutChoice == 0
    Delete "$newDesktopLink"
    WriteRegDWORD SHCTX "${INSTALL_REGISTRY_KEY}" "DesktopShortcut" 0
  ${ElseIf} $AutoLabelShortcutChoice == 1
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    WriteRegDWORD SHCTX "${INSTALL_REGISTRY_KEY}" "DesktopShortcut" 1
  ${EndIf}
!macroend
!endif

!ifdef BUILD_UNINSTALLER
Var AutoLabelBackupRoot
Var AutoLabelBackupBase
Var AutoLabelCopySource
Var AutoLabelCopyTarget
Var AutoLabelCopyName

Function un.AutoLabelPreserveDirectory
  IfFileExists "$AutoLabelCopySource" 0 un.AutoLabelPreserveDirectoryDone
  IfFileExists "$AutoLabelCopyTarget" 0 un.AutoLabelPreserveDirectoryCopy
    CreateDirectory "$AutoLabelBackupRoot"
    ClearErrors
    Rename "$AutoLabelCopyTarget" "$AutoLabelBackupRoot\$AutoLabelCopyName"
    IfErrors un.AutoLabelPreserveDirectoryFailed
  un.AutoLabelPreserveDirectoryCopy:
    ClearErrors
    ExecWait '"$SYSDIR\robocopy.exe" "$AutoLabelCopySource" "$AutoLabelCopyTarget" /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP' $R0
    IntCmp $R0 8 un.AutoLabelPreserveDirectoryFailed un.AutoLabelPreserveDirectoryDone un.AutoLabelPreserveDirectoryFailed
  un.AutoLabelPreserveDirectoryFailed:
    Abort "无法安全保留 $AutoLabelCopyName，卸载已停止。原目录仍在安装位置，请先释放磁盘空间或检查目录权限后重试。"
  un.AutoLabelPreserveDirectoryDone:
FunctionEnd

Function un.AutoLabelPreserveFile
  IfFileExists "$INSTDIR\desktop-settings.json" 0 un.AutoLabelPreserveFileDone
  IfFileExists "$LOCALAPPDATA\自动标注小助手\desktop-settings.json" 0 un.AutoLabelPreserveFileCopy
    CreateDirectory "$AutoLabelBackupRoot"
    ClearErrors
    Rename "$LOCALAPPDATA\自动标注小助手\desktop-settings.json" "$AutoLabelBackupRoot\desktop-settings.json"
    IfErrors un.AutoLabelPreserveFileFailed
  un.AutoLabelPreserveFileCopy:
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\desktop-settings.json" "$LOCALAPPDATA\自动标注小助手"
    IfErrors un.AutoLabelPreserveFileFailed
  Goto un.AutoLabelPreserveFileDone
  un.AutoLabelPreserveFileFailed:
    Abort "无法安全保留桌面配置，卸载已停止。原配置仍在安装位置，请检查目录权限后重试。"
  un.AutoLabelPreserveFileDone:
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
!macro customUnInstall
  ; 跨盘安装时 NSIS Rename 不能移动目录；用 robocopy 复制并校验退出码，失败就中止卸载。
  ; 若保留目录已有同名数据，先移到唯一备份目录，避免覆盖旧副本。
  CreateDirectory "$LOCALAPPDATA\自动标注小助手"
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  StrCpy $AutoLabelBackupBase "$LOCALAPPDATA\自动标注小助手\卸载保留-$0$1$2-$3$4$5"
  StrCpy $AutoLabelBackupRoot $AutoLabelBackupBase
  StrCpy $R9 0
  AutoLabelBackupName:
    IfFileExists "$AutoLabelBackupRoot" 0 AutoLabelBackupReady
    IntOp $R9 $R9 + 1
    StrCpy $AutoLabelBackupRoot "$AutoLabelBackupBase-$R9"
    Goto AutoLabelBackupName
  AutoLabelBackupReady:
  StrCpy $AutoLabelCopySource "$INSTDIR\AutoLabelData"
  StrCpy $AutoLabelCopyTarget "$LOCALAPPDATA\自动标注小助手\AutoLabelData"
  StrCpy $AutoLabelCopyName "AutoLabelData"
  Call un.AutoLabelPreserveDirectory
  StrCpy $AutoLabelCopySource "$INSTDIR\data"
  StrCpy $AutoLabelCopyTarget "$LOCALAPPDATA\自动标注小助手\data"
  StrCpy $AutoLabelCopyName "data"
  Call un.AutoLabelPreserveDirectory
  StrCpy $AutoLabelCopySource "$INSTDIR\credentials"
  StrCpy $AutoLabelCopyTarget "$LOCALAPPDATA\自动标注小助手\credentials"
  StrCpy $AutoLabelCopyName "credentials"
  Call un.AutoLabelPreserveDirectory
  StrCpy $AutoLabelCopySource "$INSTDIR\updates"
  StrCpy $AutoLabelCopyTarget "$LOCALAPPDATA\自动标注小助手\updates"
  StrCpy $AutoLabelCopyName "updates"
  Call un.AutoLabelPreserveDirectory
  StrCpy $AutoLabelCopySource "$INSTDIR\session-data"
  StrCpy $AutoLabelCopyTarget "$LOCALAPPDATA\自动标注小助手\session-data"
  StrCpy $AutoLabelCopyName "session-data"
  Call un.AutoLabelPreserveDirectory
  StrCpy $AutoLabelCopySource "$INSTDIR\logs"
  StrCpy $AutoLabelCopyTarget "$LOCALAPPDATA\自动标注小助手\logs"
  StrCpy $AutoLabelCopyName "logs"
  Call un.AutoLabelPreserveDirectory
  StrCpy $AutoLabelCopySource "$INSTDIR\crash-dumps"
  StrCpy $AutoLabelCopyTarget "$LOCALAPPDATA\自动标注小助手\crash-dumps"
  StrCpy $AutoLabelCopyName "crash-dumps"
  Call un.AutoLabelPreserveDirectory
  Call un.AutoLabelPreserveFile
!macroend
!endif
