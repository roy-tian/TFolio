import { useCallback, useMemo, useRef, useState } from "react"
import { Channel, invoke } from "@tauri-apps/api/core"
import { useTranslation } from "react-i18next"

import { e2eOverride } from "@/lib/e2e"
import {
  appendFiles,
  canMerge,
  inspectFiles,
  mergedPageCount,
  mergesIntoOneDocument,
  mergeWizardSteps,
  moveFile,
  usableFiles,
  type MergeBookmarksMode,
  type MergeExportMode,
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
import { wordConversionEnabled } from "@/lib/settings"
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

const MERGE_PROGRESS_PHASE_UNITS = 100

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

type MergeProgressPhase = "merge" | PdfOwnedLayer | "archive"

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
 * Runs one owned-layer command on the document a merge just made. `false` is
 * the reader's stop, which the backend has already rolled back — the wizard
 * only has to stop too.
 *
 * The tab route applies these through the session's own undo queue; an archive
 * has no tab, so it asks for them here.
 */
async function applyOwnedLayer(
  command: string,
  documentId: number,
  config: unknown,
  onProgress: (progress: PdfProgress) => void,
) {
  const channel = new Channel<PdfProgress>()

  channel.onmessage = onProgress
  return invoke<boolean>(command, { config, documentId, onProgress: channel })
}

/**
 * Runs one of the archive exports, which put up their own save dialog and
 * answer with the path they wrote. `null` is a dialog the reader dismissed or a
 * run they stopped: either way nothing was written and the wizard stays open.
 */
async function writeArchive(
  command: string,
  args: Record<string, unknown>,
  onProgress: (progress: PdfProgress) => void,
) {
  const stub = e2eOverride("exportPdfArchive")

  if (stub) {
    return stub(command, args, onProgress)
  }

  const channel = new Channel<PdfProgress>()

  channel.onmessage = onProgress
  return invoke<string | null>(command, { ...args, onProgress: channel })
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
  const [step, setStep] = useState<MergeWizardStep>("files")
  const [files, setFiles] = useState<MergeFile[]>([])
  const [exportMode, setExportMode] = useState<MergeExportMode>("onePdf")
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

  const steps = useMemo(() => mergeWizardSteps(exportMode), [exportMode])
  // The blank-page rule needs one page sequence to work on: where the files stay
  // separate there is nothing between them to pad, so the total is their sum.
  const padded = smartPadding && mergesIntoOneDocument(exportMode)
  const totalPages = useMemo(
    () => mergedPageCount(files, padded),
    [files, padded],
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
    setStep("files")
    filesRef.current = []
    setFiles([])
    setExportMode("onePdf")
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
            // The label promises what the dialog behind it accepts, and the
            // backend omits the Word extensions when the setting is off.
            filterLabel: t(
              wordConversionEnabled()
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

  // Only the steps this export actually asks can block it, and only the ones
  // that can be wrong: the file list is checked by `canMerge`. A page-number
  // range left unusable is a step behind by the time the last one is reached,
  // so the final button answers for every step the run is about to commit.
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
    (step === "files" && !canMerge(files, exportMode)) ||
    (step === "pageNumbers" && pageNumbersBroken) ||
    (isLastStep && (pageNumbersBroken || watermarkBroken))

  const goToStep = useCallback(
    (next: MergeWizardStep) => {
      setError(null)

      // Entering the page-number step re-reads the reader's stored style against
      // the merge's own length — but only while they have not edited the draft
      // themselves, so going back for one more file never undoes their work.
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

  /** The export mode is answered on the first step, where every mode's own
      steps still lie ahead — so a mode that drops the step underway can only be
      one the reader reached by another route, and it starts again from the top
      rather than leaving them on a step this export never asks. */
  const changeExportMode = useCallback(
    (mode: MergeExportMode) => {
      setError(null)
      setExportMode(mode)

      if (!mergeWizardSteps(mode).includes(step)) {
        setStep("files")
      }
    },
    [step],
  )

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
    if (!canMerge(files, exportMode) || stepBlocked || isBusy) {
      return
    }

    // Read off the steps this export actually asked: a setting from a step it
    // skipped is one the reader never saw, and must not reach the result.
    const pageNumbers =
      asks("pageNumbers") && pageNumbersOn ? pageNumbersParsed.config : null
    const watermark =
      asks("watermark") && watermarkOn
        ? { ...watermarkDraft, text: watermarkDraft.text.trim() }
        : null
    const paths = usableFiles(files).map((file) => file.path)

    unanswered.current = false
    setIsBusy(true)
    setIsStopping(false)
    setError(null)

    // Give each visible phase the same share, while its own backend events
    // describe progress within that share. Raw page counts would otherwise pin
    // a two-file merge near 0% until hundreds of layer pages began processing.
    // The copies export is one backend call from end to end, so it is one phase.
    const merges = mergesIntoOneDocument(exportMode)
    const mergeUnits = merges ? MERGE_PROGRESS_PHASE_UNITS : 0
    const pageNumberUnits = merges && pageNumbers ? MERGE_PROGRESS_PHASE_UNITS : 0
    const watermarkUnits = merges && watermark ? MERGE_PROGRESS_PHASE_UNITS : 0
    const archiveUnits =
      exportMode === "onePdf" ? 0 : MERGE_PROGRESS_PHASE_UNITS
    const operationTotal =
      mergeUnits + pageNumberUnits + watermarkUnits + archiveUnits
    const archiveOffset = mergeUnits + pageNumberUnits + watermarkUnits
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

    setMergePhase(merges ? "merge" : "archive")
    setMergeProgress({ completed: 0, total: operationTotal })

    try {
      // Nothing is merged here: each file is watermarked and written into the
      // archive on its own, by one backend call that also puts up its dialog.
      if (!merges) {
        const written = await writeArchive(
          "export_watermarked_pdf_copies",
          {
            filterLabel: t("mergeWizard.archiveFilter"),
            plan: { normalizeA4, paths, watermark },
            suggestedName: t(
              watermark
                ? "mergeWizard.copiesArchiveName"
                : "mergeWizard.copiesArchiveNamePlain",
            ),
          },
          phaseProgress("archive", archiveOffset, archiveUnits),
        )

        if (written === null) {
          return
        }

        if (watermark) {
          storeWatermarkConfig(watermark)
        }

        setOpen(false)
        return
      }

      const plan = { bookmarks, normalizeA4, paths, smartPadding }
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

      // Keep the same progress surface alive, named for whatever runs next —
      // an export with no layers to apply goes straight on to its archive.
      setMergePhase(
        pageNumbers
          ? "pageNumbers"
          : watermark
            ? "watermark"
            : exportMode === "onePdf"
              ? "merge"
              : "archive",
      )
      setMergeProgress({ completed: mergeUnits, total: operationTotal })

      const onLayerProgress: PdfOwnedLayerProgressHandler = (layer, progress) =>
        phaseProgress(
          layer,
          layer === "pageNumbers" ? mergeUnits : mergeUnits + pageNumberUnits,
          layer === "pageNumbers" ? pageNumberUnits : watermarkUnits,
        )(progress)

      // The merged document reaches the workspace as a tab, where its layers
      // are applied through the ordinary undoable commands.
      if (exportMode === "onePdf") {
        await onMerged({ document, pageNumbers, watermark }, onLayerProgress)
        setOpen(false)
        return
      }

      // An archive of images is a file, not a tab: the layers are applied to
      // the merged document here, and it is closed once its pages are written.
      try {
        if (pageNumbers) {
          const applied = await applyOwnedLayer(
            "apply_pdf_page_numbers",
            document.id,
            pageNumbers,
            (progress) => onLayerProgress("pageNumbers", progress),
          )

          if (!applied) {
            return
          }
        }

        if (watermark) {
          const applied = await applyOwnedLayer(
            "apply_pdf_watermark",
            document.id,
            watermark,
            (progress) => onLayerProgress("watermark", progress),
          )

          if (!applied) {
            return
          }
        }

        const written = await writeArchive(
          "export_pdf_page_images",
          {
            documentId: document.id,
            filterLabel: t("mergeWizard.archiveFilter"),
            suggestedName: t("mergeWizard.pagesArchiveName"),
          },
          phaseProgress("archive", archiveOffset, archiveUnits),
        )

        if (written !== null) {
          setOpen(false)
        }
      } finally {
        // The document was only ever a step on the way to the archive, so it
        // leaves the store however this ended — stopped, failed or written.
        await invoke("close_pdf", { documentId: document.id }).catch(
          () => undefined,
        )
      }
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
    asks,
    ask,
    bookmarks,
    exportMode,
    files,
    isBusy,
    normalizeA4,
    onMerged,
    pageNumbersOn,
    pageNumbersParsed.config,
    smartPadding,
    stepBlocked,
    t,
    watermarkDraft,
    watermarkOn,
  ])

  /**
   * The reader's way out of an add that is still converting Word documents —
   * the one slow thing an add can be doing, and the one the dialog's busy
   * state would otherwise give no button to. Nothing waits for the answer:
   * the inspection settles on its own, its rows answering for what stopped.
   */
  const stopAdding = useCallback(async () => {
    try {
      await invoke<boolean>("cancel_word_conversion")
    } catch {
      // Nothing to report: the run's own result closes the surface either way.
    }
  }, [])

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
    exportMode,
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
    removeFile,
    reorderFile,
    setBookmarks,
    setExportMode: changeExportMode,
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
