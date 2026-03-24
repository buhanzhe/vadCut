!ifndef DELETE_MODEL_SECTION_NAME
  !define DELETE_MODEL_SECTION_NAME "删除下载的字幕提取模型"
!endif

!ifndef VADCUT_MODEL_ROOT
  !define VADCUT_MODEL_ROOT "$PROFILE\.vadCut\model"
!endif

!ifndef VADCUT_PARAFORMER_MODEL_DIR
  !define VADCUT_PARAFORMER_MODEL_DIR "${VADCUT_MODEL_ROOT}\sherpa-onnx-streaming-paraformer-bilingual-zh-en"
!endif

!ifndef VADCUT_WHISPER_TURBO_MODEL_DIR
  !define VADCUT_WHISPER_TURBO_MODEL_DIR "${VADCUT_MODEL_ROOT}\sherpa-onnx-whisper-turbo"
!endif

!ifndef VADCUT_LEGACY_ASR_ENGINE_DIR
  !define VADCUT_LEGACY_ASR_ENGINE_DIR "${VADCUT_MODEL_ROOT}\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"
!endif

!macro customUnInstallSection
  Section /o "un.${DELETE_MODEL_SECTION_NAME}" UNINSTALL_DELETE_SUBTITLE_MODEL
    DetailPrint "删除字幕模型目录: ${VADCUT_PARAFORMER_MODEL_DIR}"
    RMDir /r "${VADCUT_PARAFORMER_MODEL_DIR}"
    DetailPrint "删除字幕模型目录: ${VADCUT_WHISPER_TURBO_MODEL_DIR}"
    RMDir /r "${VADCUT_WHISPER_TURBO_MODEL_DIR}"
    DetailPrint "删除旧字幕模型目录: ${VADCUT_LEGACY_ASR_ENGINE_DIR}"
    RMDir /r "${VADCUT_LEGACY_ASR_ENGINE_DIR}"
    RMDir "${VADCUT_MODEL_ROOT}"
    RMDir "$PROFILE\.vadCut"
  SectionEnd
!macroend
