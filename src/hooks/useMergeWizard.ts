import { useCallback, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
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
  loadPageNumbersPreferences,
  parsePageNumbersDraft,
  storePageNumbersPreferences,
  type PageNumbersConfig,
  type PageNumbersDraft,
} from "@/lib/pageNumbers"
import type { PdfDocumentInfo } from "@/lib/pdf"
import {
  defaultWatermarkConfig,
  readStoredWatermarkConfig,
  storeWatermarkConfig,
  validateWatermarkConfig,
  type WatermarkConfig,
} from "@/lib/watermark"

/** The four steps, in the order they are asked. */
export const MERGE_WIZARD_STEPS = 4

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

type UseMergeWizardOptions = {
  onMerged: (result: MergeWizardResult) => void
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
  const [error, setError] = useState<MergeWizardError>(null)
  // The list as the handlers see it: an add reads it to decide what the ceiling
  // turned away, which a state updater cannot report from inside itself.
  const filesRef = useRef<MergeFile[]>([])
  // Whether the reader has touched the page-number settings. Until they have,
  // the draft follows the file list: its range covers whatever the merge now
  // comes to, rather than a total from before the last file was added.
  const pageNumbersUntouched = useRef(true)
  const choosingRef = useRef(false)

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
    setError(null)
    pageNumbersUntouched.current = true
  }, [t])

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        reset()
      }

      setOpen(nextOpen)
    },
    [reset],
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
          draftFromPreferences(defaultPageNumbersPreferences, totalPages),
        )
        void loadPageNumbersPreferences().then((stored) => {
          if (stored && pageNumbersUntouched.current) {
            setPageNumbersDraft(draftFromPreferences(stored, totalPages))
          }
        })
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

  const finish = useCallback(async () => {
    if (!canMerge(files) || stepBlocked || isBusy) {
      return
    }

    const pageNumbers = pageNumbersOn ? pageNumbersParsed.config : null
    const watermark = watermarkOn
      ? { ...watermarkDraft, text: watermarkDraft.text.trim() }
      : null

    setIsBusy(true)
    setError(null)

    try {
      const paths = usableFiles(files).map((file) => file.path)
      const plan = { bookmarks, paths, smartPadding }
      const stub = e2eOverride("mergePdfFiles")
      const document = stub
        ? await stub(plan)
        : await invoke<PdfDocumentInfo>("merge_pdf_files", plan)

      // Remembered only once the merge itself landed, so a run that failed
      // leaves no trace in the styles the next document opens with.
      if (pageNumbers) {
        void storePageNumbersPreferences(pageNumbers)
      }
      if (watermark) {
        storeWatermarkConfig(watermark)
      }

      setOpen(false)
      onMerged({ document, pageNumbers, watermark })
    } catch (failure) {
      setError(
        String(failure).includes("MiB limit") ? "fileTooLarge" : "mergeFailed",
      )
    } finally {
      setIsBusy(false)
    }
  }, [
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

  return {
    addPaths,
    back,
    bookmarks,
    chooseFiles,
    error,
    files,
    finish,
    isBusy,
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
    totalPages,
    watermarkDraft,
    watermarkError,
    watermarkOn,
  }
}
