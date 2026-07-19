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
  type HighlightCommand,
  type RenderEpochs,
} from "@/lib/annotations"
import type { PdfExportOutcome } from "@/lib/pdf"

type UseAnnotationsOptions = {
  documentId: number | undefined
  onAnnotateError: () => void
  onExportError: () => void
  /** An export landed; `outcome` says where, and whether that was the
      document's own file. */
  onExported: (documentId: number, outcome: PdfExportOutcome) => void
  onSaveError: () => void
  onSuccess: () => void
}

/**
 * A command that fails partway is wound back rather than left where it stopped:
 * the history holds one entry for the whole command and only gains it if this
 * resolves, so a page keeping its share of a failed command would hold a mark
 * nothing could take back.
 */
async function applyCommand(documentId: number, command: AnnotationCommand) {
  switch (command.kind) {
    case "highlight":
      await applyHighlight(documentId, command)
      return
    case "rect":
      // One page, one annotation, so there is nothing to wind back: the command
      // either lands whole or leaves the page untouched.
      await invoke("add_pdf_rect_annotation", {
        bounds: command.bounds,
        documentId,
        pageNumber: command.pageNumber,
        style: command.style,
      })
      return
    case "textNote":
      // One page and one annotation, as a rectangle is.
      await invoke("add_pdf_text_note_annotation", {
        documentId,
        origin: command.origin,
        pageNumber: command.pageNumber,
        style: command.style,
        text: command.text,
      })
      return
  }
}

async function applyHighlight(documentId: number, command: HighlightCommand) {
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
  onExported,
  onSaveError,
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
   *
   * `work` resolves with whether its step actually happened: an export can end
   * with the reader cancelling the dialog, or writing somewhere other than the
   * document's own file, and either way `next` must not be applied — the
   * history would claim a save that never reached the source.
   */
  const enqueue = useCallback(
    (
      plan: (
        history: AnnotationHistory,
      ) => { pages: number[]; work: () => Promise<boolean>; next: AnnotationHistory } | null,
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
          const happened = await step.work()

          if (generation !== generationRef.current) {
            return
          }

          if (happened) {
            historyRef.current = step.next
            setHistory(step.next)
          }
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
          work: async () => {
            await applyCommand(documentId, command)
            return true
          },
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
            work: async () => {
              await retractCommand(documentId, step.entry.command)
              return true
            },
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
            work: async () => {
              await applyCommand(documentId, step.entry.command)
              return true
            },
          }
        : null
    }, onAnnotateError)
  }, [documentId, enqueue, onAnnotateError])

  /**
   * Queued behind the reader's marks rather than racing them, so the file holds
   * exactly what the history says was saved.
   *
   * The backend owns the destination dialog, so this only suggests how it
   * reads; the history is marked saved only when the write landed on the
   * document's own file — its source, or the destination a byte-opened
   * document adopts on its first export.
   */
  const exportCopy = useCallback(
    async (suggestedName: string, filterLabel: string) => {
      if (documentId === undefined) {
        return
      }

      await enqueue(
        (current) => ({
          next: markSaved(current),
          pages: [],
          work: async () => {
            const outcome = await invoke<PdfExportOutcome | null>("export_pdf", {
              documentId,
              filterLabel,
              suggestedName,
            })

            if (!outcome) {
              // The reader cancelled the dialog; nothing happened.
              return false
            }

            onExported(documentId, outcome)
            return outcome.savedToSource
          },
        }),
        onExportError,
      )
    },
    [documentId, enqueue, onExported, onExportError],
  )

  /** Writes the document back over its own file. A clean history is a no-op —
      judged inside the queue, against the history it has actually reached. */
  const save = useCallback(async () => {
    if (documentId === undefined) {
      return
    }

    await enqueue(
      (current) =>
        isDirty(current)
          ? {
              next: markSaved(current),
              pages: [],
              work: async () => {
                await invoke("save_pdf", { documentId })
                return true
              },
            }
          : null,
      onSaveError,
    )
  }, [documentId, enqueue, onSaveError])

  /**
   * The dirty answer as of this instant, off the ref rather than the rendered
   * state: a guard deciding whether marks may be discarded must not trust a
   * value that can lag the queue by a render.
   */
  const isDirtyNow = useCallback(() => isDirty(historyRef.current), [])

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
      exportCopy,
      isDirty: isDirty(history),
      isDirtyNow,
      redo: redoCommand,
      renderEpochs,
      reset,
      save,
      undo: undoCommand,
    }),
    [
      commitCommand,
      exportCopy,
      history,
      isBusy,
      isDirtyNow,
      redoCommand,
      renderEpochs,
      reset,
      save,
      undoCommand,
    ],
  )
}
