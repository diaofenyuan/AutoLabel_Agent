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
  ${NSD_CreateLabel} 0 10u 100% 32u "程序将安装到您选择的目录。项目与凭据保存在当前用户的应用数据目录，卸载不会删除项目。"
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
!macro customUnInstall
  ; 卸载会清空整个安装目录，而三类业务数据（划分好的训练集、用户上传的训练集、对话记录）
  ; 默认就放在 $INSTDIR\AutoLabelData。这里先迁到当前用户目录保留，避免用户因卸载丢数据。
  IfFileExists "$INSTDIR\AutoLabelData" 0 AutoLabelDataKept
    CreateDirectory "$LOCALAPPDATA\自动标注小助手"
    IfFileExists "$LOCALAPPDATA\自动标注小助手\AutoLabelData" 0 AutoLabelDataMove
      Rename "$LOCALAPPDATA\自动标注小助手\AutoLabelData" "$LOCALAPPDATA\自动标注小助手\AutoLabelData-旧副本"
    AutoLabelDataMove:
    Rename "$INSTDIR\AutoLabelData" "$LOCALAPPDATA\自动标注小助手\AutoLabelData"
  AutoLabelDataKept:
!macroend
!endif
