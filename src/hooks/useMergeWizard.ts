import { useCallback, useMemo, useRef, useState } from "react"
import { Channel, invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"

import { e2eOverride } from "@/lib/e2e"
import {
  appendFiles,
  canMerge,
  inspectFiles,
  mergedPageCount,
  moveFile,
  usableFiles,
  type MergeBookmarksMode,
  type MergeFile,
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

/** The four steps, in the order they are asked. */
export const MERGE_WIZARD_STEPS = 4
const MERGE_PROGRESS_PHASE_UNITS = 100

export type MergeWizardStep = 1 | 2 | 3 | 4

export type MergeWizardError =
  | "fileTooLarge"
  | "invalidFile"
  | "mergeFailed"
  | "tooManyFiles"
  | null

/** What the wizard hands the workspace: the merged document, and the page
    content the reader asked for on top of it. The two layers are applied to the
    new tab through the ordinary annotation commands rather than baked in by the
    backend, so each stays one undo away. */
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

/** Fits one backend phase's own progress into its part of the whole merge. */
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
 * The merge wizard's whole state: the file list and the three settings steps,
 * plus the one call that turns them into a document.
 *
 * Nothing here touches an open document — a merge builds a new one — so the
 * wizard lives at the workspace level rather than inside a document session.
 */
export function useMergeWizard({ onMerged }: UseMergeWizardOptions) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<MergeWizardStep>(1)
  const [files, setFiles] = useState<MergeFile[]>([])
  const [smartPadding, setSmartPadding] = useState(false)
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
  // Whether the reader has touched the page-number settings. Until they have,
  // the draft follows the file list: its range covers whatever the merge now
  // comes to, rather than a total from before the last file was added.
  const pageNumbersUntouched = useRef(true)
  const choosingRef = useRef(false)
  // Which half of the run a stop has to reach: the merge itself has no document
  // to name, and the layers that follow it run on the one it just made.
  const mergedIdRef = useRef<number | null>(null)
  // A stop the backend had nothing to answer with, still owed to the reader.
  const unanswered = useRef(false)

  const totalPages = useMemo(
    () => mergedPageCount(files, smartPadding),
    [files, smartPadding],
  )

  const applyFiles = useCallback(
    (update: (current: MergeFile[]) => MergeFile[]) => {
      const next = update(filesRef.current)

      filesRef.current = next
      setFiles(next)

      return next
    },
    [],
  )

  const changePageNumbersDraft = useCallback((next: PageNumbersDraft) => {
    pageNumbersUntouched.current = false
    setPageNumbersDraft(next)
  }, [])

  const reset = useCallback(() => {
    setStep(1)
    filesRef.current = []
    setFiles([])
    setSmartPadding(false)
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

  /** Reads the paths' page counts and adds them to the list. Used by the add
      button and by a drop onto the open wizard, which is why it takes paths
      rather than opening the dialog itself. */
  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) {
        return
      }

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
        setIsBusy(false)
      }
    },
    [applyFiles],
  )

  // The picker is the backend's own dialog, which is also what records the
  // chosen paths as ones a merge may read — see `pick_pdf_paths`.
  const chooseFiles = useCallback(async () => {
    if (choosingRef.current) {
      return
    }

    choosingRef.current = true

    try {
      const pick = e2eOverride("pickPdfPaths")
      const paths = pick
        ? await pick()
        : await invoke<string[]>("pick_pdf_paths", {
            filterLabel: t("annotate.exportFilter"),
          })

      await addPaths(paths)
    } catch {
      setError("mergeFailed")
    } finally {
      choosingRef.current = false
    }
  }, [addPaths, t])

  const removeFile = useCallback(
    (path: string) => {
      applyFiles((current) => current.filter((file) => file.path !== path))
      setError(null)
    },
    [applyFiles],
  )

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

  // What stops the reader leaving the step they are on. Only the steps that can
  // be wrong have an answer here; the file list is checked by `canMerge`.
  const pageNumbersBroken = pageNumbersOn && pageNumbersParsed.error !== null
  const watermarkBroken = watermarkOn && watermarkError !== null
  const stepBlocked =
    (step === 1 && !canMerge(files)) ||
    (step === 3 && pageNumbersBroken) ||
    // The last step's button is the merge itself, which commits both settings
    // steps — so a page-number range left unusable back on step 3 stops it too.
    (step === 4 && (pageNumbersBroken || watermarkBroken))

  const goToStep = useCallback(
    (next: MergeWizardStep) => {
      setError(null)

      // Entering the page-number step re-reads the reader's stored style against
      // the merge's own length — but only while they have not edited the draft
      // themselves, so going back for one more file never undoes their work.
      if (next === 3 && pageNumbersUntouched.current) {
        setPageNumbersDraft(
          draftFromPreferences(storedPageNumbersPreferences(), totalPages),
        )
      }

      setStep(next)
    },
    [totalPages],
  )

  const back = useCallback(() => {
    if (step > 1) {
      goToStep((step - 1) as MergeWizardStep)
    }
  }, [goToStep, step])

  const next = useCallback(() => {
    if (step < MERGE_WIZARD_STEPS && !stepBlocked) {
      goToStep((step + 1) as MergeWizardStep)
    }
  }, [goToStep, step, stepBlocked])

  /**
   * Asks whichever half of the run is going to stop, and remembers an ask the
   * backend had nothing listed to answer — which is what the progress handlers
   * below repeat, since a stop is reachable before the command behind the phase
   * they name has listed itself.
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

    const pageNumbers = pageNumbersOn ? pageNumbersParsed.config : null
    const watermark = watermarkOn
      ? { ...watermarkDraft, text: watermarkDraft.text.trim() }
      : null

    unanswered.current = false
    setIsBusy(true)
    setIsStopping(false)
    setError(null)

    const paths = usableFiles(files).map((file) => file.path)
    // Give each visible phase the same share, while its own backend events
    // describe progress within that share. Raw page counts would otherwise pin
    // a two-file merge near 0% until hundreds of layer pages began processing.
    const mergeUnits = MERGE_PROGRESS_PHASE_UNITS
    const pageNumberUnits = pageNumbers ? MERGE_PROGRESS_PHASE_UNITS : 0
    const watermarkUnits = watermark ? MERGE_PROGRESS_PHASE_UNITS : 0
    const operationTotal = mergeUnits + pageNumberUnits + watermarkUnits
    setMergePhase("merge")
    setMergeProgress({ completed: 0, total: operationTotal })

    try {
      const plan = { bookmarks, paths, smartPadding }
      const stub = e2eOverride("mergePdfFiles")
      const onMergeProgress = (progress: PdfProgress) => {
        setMergeProgress({
          completed: completedPhaseUnits(progress, mergeUnits),
          total: operationTotal,
        })

        if (unanswered.current) {
          void ask()
        }
      }
      let document: PdfDocumentInfo | null

      if (stub) {
        document = await stub(plan, onMergeProgress)
      } else {
        const progress = new Channel<PdfProgress>()
        progress.onmessage = onMergeProgress
        document = await invoke<PdfDocumentInfo | null>("merge_pdf_files", {
          ...plan,
          onProgress: progress,
        })
      }

      // A merge the reader stopped built nothing, so there is nothing to open,
      // nothing to remember, and nothing to report: the wizard stays on its
      // last step with the list and the settings they assembled still there.
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

      // Keep the same progress surface alive while the new session applies the
      // optional layers through its ordinary, undoable commands.
      setMergePhase(pageNumbers ? "pageNumbers" : watermark ? "watermark" : "merge")
      setMergeProgress({ completed: mergeUnits, total: operationTotal })

      const onLayerProgress: PdfOwnedLayerProgressHandler = (layer, progress) => {
        const pageNumberOffset = mergeUnits
        const watermarkOffset = mergeUnits + pageNumberUnits
        const units = layer === "pageNumbers" ? pageNumberUnits : watermarkUnits
        const offset =
          layer === "pageNumbers" ? pageNumberOffset : watermarkOffset

        setMergePhase(layer)
        setMergeProgress({
          completed: offset + completedPhaseUnits(progress, units),
          total: operationTotal,
        })

        if (unanswered.current) {
          void ask()
        }
      }

      await onMerged({ document, pageNumbers, watermark }, onLayerProgress)
      setOpen(false)
    } catch (failure) {
      setError(
        String(failure).includes("MiB limit") ? "fileTooLarge" : "mergeFailed",
      )
    } finally {
      setMergeProgress(null)
      setIsBusy(false)
      setIsStopping(false)
      mergedIdRef.current = null
    }
  }, [
    ask,
    bookmarks,
    files,
    isBusy,
    onMerged,
    pageNumbersOn,
    pageNumbersParsed.config,
    smartPadding,
    stepBlocked,
    watermarkDraft,
    watermarkOn,
  ])

  /**
   * The reader's way out of a run that has already started — the wizard's whole
   * job is behind one PDFium lock, so this is the only message that reaches it
   * while it holds one.
   *
   * Which half is running decides who is asked: the merge has no document to
   * name, and the layers that follow run on the document it produced. Nothing
   * waits for the answer; the run's own result closes the surface.
   *
   * The phase this button names flips the moment the merge lands, well before
   * the layer command behind it exists to be stopped — so an ask that reaches
   * nothing is repeated from the progress that follows.
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
    error,
    files,
    finish,
    isBusy,
    isStopping,
    mergePhase,
    mergeProgress,
    next,
    onOpenChange,
    open,
    openWizard,
    pageNumbersDraft,
    pageNumbersError: pageNumbersParsed.error,
    pageNumbersOn,
    removeFile,
    reorderFile,
    setBookmarks,
    setPageNumbersDraft: changePageNumbersDraft,
    setPageNumbersOn,
    setSmartPadding,
    setWatermarkDraft,
    setWatermarkOn,
    smartPadding,
    step,
    stepBlocked,
    stop,
    totalPages,
    watermarkDraft,
    watermarkError,
    watermarkOn,
  }
}
