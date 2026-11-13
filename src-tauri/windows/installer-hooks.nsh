; Which app opens a file is the reader's choice, made in Open with or Default
; apps. Tauri's own file associations overwrite each extension's default ProgID
; (and named one class "Word Document"), so tauri.windows.conf.json empties them
; and these hooks only offer TFolio for PDFs. Kept in step with
; pdf-association.wxs.

!macro TFOLIO_OFFER_PDF
  DeleteRegKey SHCTX "Software\Classes\TFolio.PDF"
  WriteRegStr SHCTX "Software\Classes\TFolio.PDF" "" "PDF Document"
  WriteRegStr SHCTX "Software\Classes\TFolio.PDF\DefaultIcon" "" '"$INSTDIR\icons\pdf.ico",0'
  WriteRegStr SHCTX "Software\Classes\TFolio.PDF\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "TFolio.PDF" ""
  WriteRegStr SHCTX "Software\TFolio\Capabilities" "ApplicationName" "TFolio"
  WriteRegStr SHCTX "Software\TFolio\Capabilities" "ApplicationDescription" "Read and edit PDF documents."
  WriteRegStr SHCTX "Software\TFolio\Capabilities\FileAssociations" ".pdf" "TFolio.PDF"
  WriteRegStr SHCTX "Software\RegisteredApplications" "TFolio" "Software\TFolio\Capabilities"
!macroend

!macro TFOLIO_WITHDRAW_PDF
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "TFolio.PDF"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.pdf\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.pdf"
  DeleteRegKey SHCTX "Software\Classes\TFolio.PDF"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "TFolio"
  DeleteRegKey /ifempty SHCTX "Software\RegisteredApplications"
  DeleteRegKey SHCTX "Software\TFolio\Capabilities"
  DeleteRegKey /ifempty SHCTX "Software\TFolio"
!macroend

; Installers up to 0.1.28 set `.EXT`'s default to CLASS, setting the one before
; aside as `CLASS_backup`, which every update then overwrote with CLASS itself.
; Another app may use a generic CLASS too, so one that opens some other program
; is left alone; a missing one is ours, removed by an old uninstaller.
!macro TFOLIO_RESTORE_DEFAULT EXT CLASS
  StrCpy $R2 1
  !if "${CLASS}" != "TFolio.PDF"
    ClearErrors
    ReadRegStr $R0 SHCTX "Software\Classes\${CLASS}\shell\open\command" ""
    ${IfNot} ${Errors}
    ${AndIf} $R0 != '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
      StrCpy $R2 0
    ${EndIf}
  !endif
  ${If} $R2 = 1
    ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
    ${If} $R0 == "${CLASS}"
      ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" "${CLASS}_backup"
      ${If} $R0 == "${CLASS}"
        StrCpy $R0 ""
      ${EndIf}
      WriteRegStr SHCTX "Software\Classes\.${EXT}" "" $R0
    ${EndIf}
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${CLASS}_backup"
  ${EndIf}
  ; An empty default, which their uninstaller also left, hides the machine's.
  ClearErrors
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  ${IfNot} ${Errors}
  ${AndIf} $R0 == ""
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
  ${EndIf}
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}"
!macroend

; Sets $R1 to 1 when the reader picked CHOSEN_CLASS for `.CHOSEN_EXT`; Windows
; 11 24H2 also keeps the pick under UserChoiceLatest.
!macro TFOLIO_CHECK_CHOSEN CHOSEN_EXT CHOSEN_CLASS
  ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.${CHOSEN_EXT}\UserChoice" "ProgId"
  ${If} $R2 == "${CHOSEN_CLASS}"
    StrCpy $R1 1
  ${EndIf}
  ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.${CHOSEN_EXT}\UserChoiceLatest\ProgId" "ProgId"
  ${If} $R2 == "${CHOSEN_CLASS}"
    StrCpy $R1 1
  ${EndIf}
!macroend

; Removes a CLASS those installers made, if it still opens this copy. Keeping a
; class the reader picked leaves their choice working until TFolio is removed.
!macro TFOLIO_DROP_CLASS CLASS EXT1 EXT2 KEEP_CHOSEN
  StrCpy $R1 0
  !if "${KEEP_CHOSEN}" == "1"
    !insertmacro TFOLIO_CHECK_CHOSEN "${EXT1}" "${CLASS}"
    !if "${EXT2}" != "${EXT1}"
      !insertmacro TFOLIO_CHECK_CHOSEN "${EXT2}" "${CLASS}"
    !endif
  !endif
  ReadRegStr $R0 SHCTX "Software\Classes\${CLASS}\shell\open\command" ""
  StrCpy $R3 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ${If} $R0 == $R3
  ${AndIf} $R1 = 0
    DeleteRegKey SHCTX "Software\Classes\${CLASS}"
  ${EndIf}
!macroend

; `TFolio.PDF` replaced `PDF` in 0.1.9, so it is restored first: its backup can
; be `PDF`, whose own backup holds the default from before TFolio. A 0.1.6–0.1.8
; installed after a later one backed up `TFolio.PDF`, so that is cleared again.
!macro TFOLIO_FORGET_CLAIMS KEEP
  !insertmacro TFOLIO_RESTORE_DEFAULT "pdf" "TFolio.PDF"
  !insertmacro TFOLIO_RESTORE_DEFAULT "pdf" "PDF"
  !insertmacro TFOLIO_RESTORE_DEFAULT "pdf" "TFolio.PDF"
  !insertmacro TFOLIO_RESTORE_DEFAULT "doc" "Word Document"
  !insertmacro TFOLIO_RESTORE_DEFAULT "docx" "Word Document"
  !insertmacro TFOLIO_RESTORE_DEFAULT "bmp" "Bitmap Image"
  !insertmacro TFOLIO_RESTORE_DEFAULT "gif" "GIF Image"
  !insertmacro TFOLIO_RESTORE_DEFAULT "jpg" "JPEG Image"
  !insertmacro TFOLIO_RESTORE_DEFAULT "jpeg" "JPEG Image"
  !insertmacro TFOLIO_RESTORE_DEFAULT "png" "PNG Image"
  !insertmacro TFOLIO_RESTORE_DEFAULT "tif" "TIFF Image"
  !insertmacro TFOLIO_RESTORE_DEFAULT "tiff" "TIFF Image"
  !insertmacro TFOLIO_RESTORE_DEFAULT "webp" "WebP Image"
  !insertmacro TFOLIO_DROP_CLASS "PDF" "pdf" "pdf" "${KEEP}"
  !insertmacro TFOLIO_DROP_CLASS "Word Document" "doc" "docx" "${KEEP}"
  !insertmacro TFOLIO_DROP_CLASS "Bitmap Image" "bmp" "bmp" "${KEEP}"
  !insertmacro TFOLIO_DROP_CLASS "GIF Image" "gif" "gif" "${KEEP}"
  !insertmacro TFOLIO_DROP_CLASS "JPEG Image" "jpg" "jpeg" "${KEEP}"
  !insertmacro TFOLIO_DROP_CLASS "PNG Image" "png" "png" "${KEEP}"
  !insertmacro TFOLIO_DROP_CLASS "TIFF Image" "tif" "tiff" "${KEEP}"
  !insertmacro TFOLIO_DROP_CLASS "WebP Image" "webp" "webp" "${KEEP}"
!macroend

!macro TFOLIO_SAVE_REGISTERS
  Push $R0
  Push $R1
  Push $R2
  Push $R3
!macroend

!macro TFOLIO_RESTORE_REGISTERS
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro TFOLIO_SAVE_REGISTERS
  !insertmacro TFOLIO_FORGET_CLAIMS 1
  !insertmacro TFOLIO_OFFER_PDF
  !insertmacro TFOLIO_RESTORE_REGISTERS
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro TFOLIO_SAVE_REGISTERS
  !insertmacro TFOLIO_FORGET_CLAIMS 0
  !insertmacro TFOLIO_WITHDRAW_PDF
  !insertmacro TFOLIO_RESTORE_REGISTERS
  !insertmacro UPDATEFILEASSOC
!macroend
