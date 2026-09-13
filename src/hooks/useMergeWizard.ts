import { useCallback, useMemo, useRef, useState } from "react"
import { Channel, invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"

import { e2eOverride } from "@/lib/e2e"
import {
  a4Status,
  appendFiles,
  canMerge,
  inspectFiles,
  mergedPageCount,
  padPageCount,
  mergeWizardSteps,
  moveFile,
  usableFiles,
  type MergeBookmarksMode,
  type MergeFile,
  type MergeWizardStep,
} from "@/lib/mergeWizard"
import {
  defaultPageNumbersPreferences,
  draftFromPreferences,
  parsePageNumbersDraft,
  storedPageNumbersPreferences,
  storePageNumbersPreferences,
  type PageNumbersConfig,
  type PageNumbersDraft,
} from "@/lib/pageNumbers"
import type { PdfDocumentInfo } from "@/lib/pdf"
import type {
  PdfOwnedLayer,
  PdfOwnedLayerProgressHandler,
  PdfProgress,
} from "@/lib/progress"
import {
  defaultWatermarkConfig,
  readStoredWatermarkConfig,
  storeWatermarkConfig,
  validateWatermarkConfig,
  type WatermarkConfig,
} from "@/lib/watermark"
import { wordConversionAvailable } from "@/lib/wordConversion"

const MERGE_PROGRESS_PHASE_UNITS = 100

export type MergeWizardError =
  | "fileTooLarge"
  | "invalidFile"
  | "mergeFailed"
  | "tooManyFiles"
  | null

/** The layers are applied through the tab's ordinary annotation commands
    rather than baked in by the backend, so each stays one undo away. */
export type MergeWizardResult = {
  document: PdfDocumentInfo
  pageNumbers: PageNumbersConfig | null
  watermark: WatermarkConfig | null
}

type MergeProgressPhase = "merge" | PdfOwnedLayer

type UseMergeWizardOptions = {
  onMerged: (
    result: MergeWizardResult,
    onLayerProgress: PdfOwnedLayerProgressHandler,
  ) => Promise<void>
}

function completedPhaseUnits(progress: PdfProgress, units: number) {
  if (
    !Number.isFinite(progress.completed) ||
    !Number.isFinite(progress.total) ||
    progress.total <= 0
  ) {
    return 0
  }

  return Math.round(
    Math.min(1, Math.max(0, progress.completed / progress.total)) * units,
  )
}

/**
 * A merge builds a new document and touches no open one, so the wizard lives
 * at the workspace level rather than inside a document session.
 */
export function useMergeWizard({ onMerged }: UseMergeWizardOptions) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<MergeWizardStep>("files")
  const [files, setFiles] = useState<MergeFile[]>([])
  const [bookmarksOn, setBookmarksOn] = useState(true)
  const [smartPadding, setSmartPadding] = useState(false)
  const [normalizeA4, setNormalizeA4] = useState(false)
  const [bookmarks, setBookmarks] = useState<MergeBookmarksMode>("perFile")
  const [pageNumbersOn, setPageNumbersOn] = useState(false)
  const [watermarkOn, setWatermarkOn] = useState(false)
  const [pageNumbersDraft, setPageNumbersDraft] = useState<PageNumbersDraft>(() =>
    draftFromPreferences(defaultPageNumbersPreferences, 0),
  )
  const [watermarkDraft, setWatermarkDraft] = useState<WatermarkConfig>(() =>
    defaultWatermarkConfig(""),
  )
  const [isBusy, setIsBusy] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [mergePhase, setMergePhase] = useState<MergeProgressPhase>("merge")
  const [mergeProgress, setMergeProgress] = useState<PdfProgress | null>(null)
  const [error, setError] = useState<MergeWizardError>(null)
  // The list as the handlers see it: an add reads it to decide what the ceiling
  // turned away, which a state updater cannot report from inside itself.
  const filesRef = useRef<MergeFile[]>([])
  // Until the reader touches the settings, the draft follows the file list —
  // its range covers whatever the merge now comes to.
  const pageNumbersUntouched = useRef(true)
  const choosingRef = useRef(false)
  const busyRef = useRef(false)
  // Which half of the run a stop has to reach: the merge itself has no document
  // to name, and the layers that follow it run on the one it just made.
  const mergedIdRef = useRef<number | null>(null)
  // A stop the backend had nothing to answer with, still owed to the reader.
  const unanswered = useRef(false)

  const steps = useMemo(
    () => mergeWizardSteps({ bookmarksOn, pageNumbersOn, watermarkOn }),
    [bookmarksOn, pageNumbersOn, watermarkOn],
  )
  const pageSizeStatus = a4Status(files)
  const paddingNeeded = padPageCount(files, true)
  const totalPages = useMemo(
    () => mergedPageCount(files, smartPadding),
    [files, smartPadding],
  )

  const applyFiles = useCallback(
    (update: (current: MergeFile[]) => MergeFile[]) => {
      const next = update(filesRef.current)

      filesRef.current = next
      setFiles(next)
      const sizeStatus = a4Status(next)
      if (sizeStatus === "empty" || sizeStatus === "allA4") {
        setNormalizeA4(false)
      }
      if (padPageCount(next, true) === 0) {
        setSmartPadding(false)
      }

      return next
    },
    [],
  )

  const changePageNumbersDraft = useCallback((next: PageNumbersDraft) => {
    pageNumbersUntouched.current = false
    setPageNumbersDraft(next)
  }, [])

  const reset = useCallback(() => {
    setStep("files")
    filesRef.current = []
    setFiles([])
    setBookmarksOn(true)
    setSmartPadding(false)
    setNormalizeA4(false)
    setBookmarks("perFile")
    setPageNumbersOn(false)
    setWatermarkOn(false)
    setPageNumbersDraft(draftFromPreferences(defaultPageNumbersPreferences, 0))
    setWatermarkDraft(
      readStoredWatermarkConfig() ??
        defaultWatermarkConfig(t("watermark.defaultText")),
    )
    setIsBusy(false)
    setIsStopping(false)
    setMergePhase("merge")
    setMergeProgress(null)
    setError(null)
    pageNumbersUntouched.current = true
    mergedIdRef.current = null
    unanswered.current = false
  }, [t])

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      // A long merge stays visible until it settles. Success closes the wizard
      // directly in `finish`; a failure returns it to the editable last step.
      if (!nextOpen && isBusy) {
        return
      }

      if (nextOpen) {
        reset()
      }

      setOpen(nextOpen)
    },
    [isBusy, reset],
  )

  const openWizard = useCallback(() => onOpenChange(true), [onOpenChange])

  /** Takes paths rather than opening the dialog because a drop onto the open
      wizard uses it as well as the add button. */
  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0 || busyRef.current || mergedIdRef.current !== null) {
        return
      }

      busyRef.current = true
      setIsBusy(true)

      try {
        const inspected = await inspectFiles(paths)

        if (inspected.length === 0) {
          setError("invalidFile")
          return
        }

        let dropped = 0

        applyFiles((current) => {
          const added = appendFiles(current, inspected)

          dropped = added.dropped
          return added.files
        })
        setError(dropped > 0 ? "tooManyFiles" : null)
      } catch {
        setError("mergeFailed")
      } finally {
        busyRef.current = false
        setIsBusy(false)
      }
    },
    [applyFiles],
  )

  // The picker is the backend's own dialog, which is also what records the
  // chosen paths as ones a merge may read — see `pick_pdf_paths`.
  const chooseFiles = useCallback(async () => {
    if (choosingRef.current || isBusy) {
      return
    }

    choosingRef.current = true

    try {
      const pick = e2eOverride("pickPdfPaths")
      const paths = pick
        ? await pick()
        : await invoke<string[]>("pick_pdf_paths", {
            // The label promises what the dialog behind it accepts, and the
            // backend omits the Word extensions when no suite was detected.
            filterLabel: t(
              wordConversionAvailable()
                ? "mergeWizard.sourceFilter"
                : "mergeWizard.sourceFilterPlain",
            ),
          })

      await addPaths(paths)
    } catch {
      setError("mergeFailed")
    } finally {
      choosingRef.current = false
    }
  }, [addPaths, isBusy, t])

  const removeFile = useCallback(
    (path: string) => {
      applyFiles((current) => current.filter((file) => file.path !== path))
      setError(null)
    },
    [applyFiles],
  )

  const clearFiles = useCallback(() => {
    applyFiles(() => [])
    setError(null)
  }, [applyFiles])

  const reorderFile = useCallback(
    (from: number, to: number) => {
      applyFiles((current) => moveFile(current, from, to))
    },
    [applyFiles],
  )

  const pageNumbersParsed = useMemo(
    () => parsePageNumbersDraft(pageNumbersDraft, totalPages),
    [pageNumbersDraft, totalPages],
  )
  const watermarkError = useMemo(
    () => validateWatermarkConfig(watermarkDraft),
    [watermarkDraft],
  )

  // Disabled features keep their drafts without blocking the chosen result.
  const asks = useCallback(
    (named: MergeWizardStep) => steps.includes(named),
    [steps],
  )
  const pageNumbersBroken =
    asks("pageNumbers") && pageNumbersOn && pageNumbersParsed.error !== null
  const watermarkBroken =
    asks("watermark") && watermarkOn && watermarkError !== null
  const isLastStep = step === steps[steps.length - 1]
  const stepBlocked =
    (step === "files" && !canMerge(files)) ||
    (step === "pageNumbers" && pageNumbersBroken) ||
    (isLastStep && (pageNumbersBroken || watermarkBroken))

  const goToStep = useCallback(
    (next: MergeWizardStep) => {
      setError(null)

      // Re-reads the stored style against the merge's length only while the
      // reader has not edited the draft, so a detour never undoes their work.
      if (next === "pageNumbers" && pageNumbersUntouched.current) {
        setPageNumbersDraft(
          draftFromPreferences(storedPageNumbersPreferences(), totalPages),
        )
      }

      setStep(next)
    },
    [totalPages],
  )

  const back = useCallback(() => {
    const previous = steps[steps.indexOf(step) - 1]

    if (previous) {
      goToStep(previous)
    }
  }, [goToStep, step, steps])

  const next = useCallback(() => {
    const following = steps[steps.indexOf(step) + 1]

    if (following && !stepBlocked) {
      goToStep(following)
    }
  }, [goToStep, step, stepBlocked, steps])

  /**
   * Remembers an ask the backend had nothing listed to answer; the progress
   * handlers repeat it, a stop being reachable before the command lists itself.
   */
  const ask = useCallback(async () => {
    const documentId = mergedIdRef.current

    try {
      const asked = await (documentId === null
        ? invoke<boolean>("cancel_pdf_merge")
        : invoke<boolean>("cancel_pdf_operation", { documentId }))

      if (asked) {
        unanswered.current = false
      }
    } catch {
      // Nothing to report: the run's own result closes the surface either way.
    }
  }, [])

  const finish = useCallback(async () => {
    if (!canMerge(files) || stepBlocked || isBusy) {
      return
    }

    // Disabled features must not apply drafts retained from a previous visit.
    const pageNumbers =
      asks("pageNumbers") && pageNumbersOn ? pageNumbersParsed.config : null
    const watermark =
      asks("watermark") && watermarkOn
        ? { ...watermarkDraft, text: watermarkDraft.text.trim() }
        : null
    const paths = usableFiles(files).map((file) => file.path)

    unanswered.current = false
    busyRef.current = true
    setIsBusy(true)
    setIsStopping(false)
    setError(null)

    // Each phase gets the same share: raw page counts would pin a two-file
    // merge near 0% until hundreds of layer pages began processing.
    const mergeUnits = MERGE_PROGRESS_PHASE_UNITS
    const pageNumberUnits = pageNumbers ? MERGE_PROGRESS_PHASE_UNITS : 0
    const watermarkUnits = watermark ? MERGE_PROGRESS_PHASE_UNITS : 0
    const operationTotal = mergeUnits + pageNumberUnits + watermarkUnits
    const phaseProgress =
      (phase: MergeProgressPhase, offset: number, units: number) =>
      (progress: PdfProgress) => {
        setMergePhase(phase)
        setMergeProgress({
          completed: offset + completedPhaseUnits(progress, units),
          total: operationTotal,
        })

        if (unanswered.current) {
          void ask()
        }
      }

    setMergePhase("merge")
    setMergeProgress({ completed: 0, total: operationTotal })

    try {
      const plan = {
        bookmarks: bookmarksOn ? bookmarks : "none",
        normalizeA4,
        paths,
        smartPadding,
      }
      const stub = e2eOverride("mergePdfFiles")
      const onMergeProgress = phaseProgress("merge", 0, mergeUnits)
      let document: PdfDocumentInfo | null

      if (stub) {
        document = await stub(plan, onMergeProgress)
      } else {
        const progress = new Channel<PdfProgress>()
        progress.onmessage = onMergeProgress
        document = await invoke<PdfDocumentInfo | null>("merge_pdf_files", {
          onProgress: progress,
          plan,
        })
      }

      // A stopped merge built nothing to open, remember, or report: the wizard
      // stays on its last step with the list and settings still there.
      if (!document) {
        return
      }

      mergedIdRef.current = document.id

      // Remembered only once the base merge landed, so a run that failed before
      // producing a document leaves no trace in the next document's styles.
      if (pageNumbers) {
        storePageNumbersPreferences(pageNumbers)
      }
      if (watermark) {
        storeWatermarkConfig(watermark)
      }

      setMergePhase(pageNumbers ? "pageNumbers" : watermark ? "watermark" : "merge")
      setMergeProgress({ completed: mergeUnits, total: operationTotal })

      const onLayerProgress: PdfOwnedLayerProgressHandler = (layer, progress) =>
        phaseProgress(
          layer,
          layer === "pageNumbers" ? mergeUnits : mergeUnits + pageNumberUnits,
          layer === "pageNumbers" ? pageNumberUnits : watermarkUnits,
        )(progress)

      await onMerged({ document, pageNumbers, watermark }, onLayerProgress)
      setOpen(false)
    } catch (failure) {
      setError(
        String(failure).includes("MiB limit") ? "fileTooLarge" : "mergeFailed",
      )
    } finally {
      setMergeProgress(null)
      busyRef.current = false
      setIsBusy(false)
      setIsStopping(false)
      mergedIdRef.current = null
    }
  }, [
    asks,
    ask,
    bookmarks,
    bookmarksOn,
    files,
    isBusy,
    normalizeA4,
    onMerged,
    pageNumbersOn,
    pageNumbersParsed.config,
    smartPadding,
    stepBlocked,
    watermarkDraft,
    watermarkOn,
  ])

  /**
   * The one button an add still converting Word documents can offer; nothing
   * waits for the answer, the inspection settles on its own.
   */
  const stopAdding = useCallback(async () => {
    try {
      await invoke<boolean>("cancel_word_conversion")
    } catch {
      // Nothing to report: the run's own result closes the surface either way.
    }
  }, [])

  /**
   * The whole run sits behind one PDFium lock, so this cancel is the only
   * message that reaches it; nothing waits, the run's result closes things.
   */
  const stop = useCallback(() => {
    if (mergeProgress === null) {
      return
    }

    unanswered.current = true
    setIsStopping(true)
    void ask()
  }, [ask, mergeProgress])

  return {
    addPaths,
    back,
    bookmarks,
    chooseFiles,
    clearFiles,
    error,
    bookmarksOn,
    files,
    finish,
    isBusy,
    isLastStep,
    isStopping,
    mergePhase,
    mergeProgress,
    next,
    normalizeA4,
    onOpenChange,
    open,
    openWizard,
    pageNumbersDraft,
    pageNumbersError: pageNumbersParsed.error,
    pageNumbersOn,
    pageSizeStatus,
    paddingNeeded,
    removeFile,
    reorderFile,
    setBookmarks,
    setBookmarksOn,
    setNormalizeA4,
    setPageNumbersDraft: changePageNumbersDraft,
    setPageNumbersOn,
    setSmartPadding,
    setWatermarkDraft,
    setWatermarkOn,
    smartPadding,
    stopAdding,
    step,
    stepBlocked,
    steps,
    stop,
    totalPages,
    watermarkDraft,
    watermarkError,
    watermarkOn,
  }
}
