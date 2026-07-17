import { useCallback, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

import {
  canRedo,
  canUndo,
  commandPages,
  commit,
  emptyHistory,
  isDirty,
  markSaved,
  redo,
  undo,
  type AnnotationCommand,
  type AnnotationHistory,
  type RenderEpochs,
} from "@/lib/annotations"

type UseAnnotationsOptions = {
  documentId: number | undefined
  onAnnotateError: () => void
  onExportError: () => void
  onSuccess: () => void
}

/**
 * A command that fails partway is wound back rather than left where it stopped:
 * the history holds one entry for the whole command and only gains it if this
 * resolves, so a page keeping its share of a failed command would hold a mark
 * nothing could take back.
 */
async function applyCommand(documentId: number, command: AnnotationCommand) {
  const written: number[] = []

  try {
    for (const target of command.targets) {
      await invoke("add_pdf_highlight_annotation", {
        color: command.color,
        documentId,
        opacity: command.opacity,
        pageNumber: target.pageNumber,
        quads: target.quads,
      })
      written.push(target.pageNumber)
    }
  } catch (error) {
    for (const pageNumber of written.reverse()) {
      await invoke("delete_last_pdf_annotation", { documentId, pageNumber }).catch(
        () => undefined,
      )
    }

    throw error
  }
}

/**
 * Unwound in reverse of `applyCommand`: the backend removes whichever annotation
 * a page was given last, so the two have to agree about what "last" means.
 */
async function retractCommand(documentId: number, command: AnnotationCommand) {
  for (const pageNumber of [...commandPages(command)].reverse()) {
    await invoke("delete_last_pdf_annotation", { documentId, pageNumber })
  }
}

/**
 * The document PDFium holds is the truth about what is on a page, so nothing
 * here mirrors the annotations. This keeps only what PDFium cannot answer: what
 * the reader did, in what order, and how much they have taken back.
 */
export function useAnnotations({
  documentId,
  onAnnotateError,
  onExportError,
  onSuccess,
}: UseAnnotationsOptions) {
  const [history, setHistory] = useState<AnnotationHistory>(emptyHistory)
  const [renderEpochs, setRenderEpochs] = useState<RenderEpochs>({})
  const [pending, setPending] = useState(0)
  // React state does not move until a re-render, so an operation starting inside
  // another's round trip would plan against a history a step out of date and
  // overwrite its entry.
  const historyRef = useRef(emptyHistory)
  // Bumped when the document changes, so work still in flight against the last
  // one lands nowhere rather than on its successor.
  const generationRef = useRef(0)
  // PDFium serializes this work anyway; the queue makes the history move in the
  // same order, so `undo` is never planned against a document a queued `commit`
  // is about to change.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())

  const applyEpochs = useCallback((pageNumbers: number[]) => {
    setRenderEpochs((epochs) => {
      const next = { ...epochs }

      for (const pageNumber of pageNumbers) {
        next[pageNumber] = (next[pageNumber] ?? 0) + 1
      }

      return next
    })
  }, [])

  /**
   * `plan` reads the history the queue has reached and returns the work to do
   * and the history to leave behind — both decided inside the queue, which is
   * what makes them consistent with each other.
   */
  const enqueue = useCallback(
    (
      plan: (
        history: AnnotationHistory,
      ) => { pages: number[]; work: () => Promise<void>; next: AnnotationHistory } | null,
      onFailure: () => void,
    ) => {
      if (documentId === undefined) {
        return queueRef.current
      }

      const generation = generationRef.current

      setPending((count) => count + 1)

      queueRef.current = queueRef.current.then(async () => {
        // The document changed while this waited its turn.
        if (generation !== generationRef.current) {
          return
        }

        const step = plan(historyRef.current)

        if (!step) {
          return
        }

        try {
          await step.work()

          if (generation !== generationRef.current) {
            return
          }

          historyRef.current = step.next
          setHistory(step.next)
          onSuccess()
        } catch {
          if (generation === generationRef.current) {
            onFailure()
          }
        } finally {
          // Whether or not the work succeeded: a command that failed partway
          // still changed the pages it reached.
          if (generation === generationRef.current) {
            applyEpochs(step.pages)
          }
        }
      })

      return queueRef.current.finally(() => setPending((count) => count - 1))
    },
    [applyEpochs, documentId, onSuccess],
  )

  const commitCommand = useCallback(
    async (command: AnnotationCommand) => {
      if (documentId === undefined) {
        return
      }

      await enqueue(
        (current) => ({
          next: commit(current, command),
          pages: commandPages(command),
          work: () => applyCommand(documentId, command),
        }),
        onAnnotateError,
      )
    },
    [documentId, enqueue, onAnnotateError],
  )

  const undoCommand = useCallback(async () => {
    if (documentId === undefined) {
      return
    }

    await enqueue((current) => {
      const step = undo(current)

      return step
        ? {
            next: step.history,
            pages: commandPages(step.entry.command),
            work: () => retractCommand(documentId, step.entry.command),
          }
        : null
    }, onAnnotateError)
  }, [documentId, enqueue, onAnnotateError])

  const redoCommand = useCallback(async () => {
    if (documentId === undefined) {
      return
    }

    await enqueue((current) => {
      const step = redo(current)

      return step
        ? {
            next: step.history,
            pages: commandPages(step.entry.command),
            work: () => applyCommand(documentId, step.entry.command),
          }
        : null
    }, onAnnotateError)
  }, [documentId, enqueue, onAnnotateError])

  /**
   * Queued behind the reader's marks rather than racing them, so the file holds
   * exactly what the history says was saved.
   */
  const exportTo = useCallback(
    async (path: string) => {
      if (documentId === undefined) {
        return
      }

      await enqueue(
        (current) => ({
          next: markSaved(current),
          pages: [],
          work: () => invoke("export_pdf", { documentId, path }),
        }),
        onExportError,
      )
    },
    [documentId, enqueue, onExportError],
  )

  const reset = useCallback(() => {
    generationRef.current += 1
    historyRef.current = emptyHistory
    setHistory(emptyHistory)
    setRenderEpochs({})
  }, [])

  const isBusy = pending > 0

  return useMemo(
    () => ({
      canRedo: canRedo(history) && !isBusy,
      canUndo: canUndo(history) && !isBusy,
      commit: commitCommand,
      exportTo,
      isDirty: isDirty(history),
      redo: redoCommand,
      renderEpochs,
      reset,
      undo: undoCommand,
    }),
    [commitCommand, exportTo, history, isBusy, redoCommand, renderEpochs, reset, undoCommand],
  )
}
