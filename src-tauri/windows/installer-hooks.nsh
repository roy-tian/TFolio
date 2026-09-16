; Tauri registers the executable icon first; point its PDF class to the size-specific artwork.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\TFolio.PDF\DefaultIcon" "" '"$INSTDIR\icons\pdf.ico",0'
  !insertmacro UPDATEFILEASSOC
!macroend
