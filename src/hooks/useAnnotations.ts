import { useCallback, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

import {
  canRedo,
  canUndo,
  commandPages,
  commandTextPages,
  commit,
  emptyHistory,
  fillMergeOutcome,
  isDirty,
  markSaved,
  mergeFilePages,
  pageNumbersConfig as currentPageNumbersConfig,
  planDeletePages,
  planInsertBlankPage,
  planMergeFile,
  planPageNumbersChange,
  planReorderPages,
  planWatermarkChange,
  redo,
  undo,
  watermarkConfig as currentWatermarkConfig,
  type AnnotationCommand,
  type AnnotationHistory,
  type HighlightCommand,
  type RenderEpochs,
} from "@/lib/annotations"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import type {
  PdfExportOutcome,
  PdfMergeOutcome,
  PdfStructureUpdate,
} from "@/lib/pdf"
import type { WatermarkConfig } from "@/lib/watermark"

/** Where a structure command's fresh metadata lands, applied or undone. */
type StructureChangeHandler = (
  documentId: number,
  update: PdfStructureUpdate,
) => void

type UseAnnotationsOptions = {
  documentId: number | undefined
  onAnnotateError: () => void
  onExportError: () => void
  /** An export landed; `outcome` says where, and whether that was the
      document's own file. */
  onExported: (documentId: number, outcome: PdfExportOutcome) => void
  onSaveError: () => void
  /** A structure command changed the page list; `update` replaces the
      document's metadata wholesale. */
  onStructureChange: StructureChangeHandler
  onSuccess: () => void
}

/**
 * A command that fails partway is wound back rather than left where it stopped:
 * the history holds one entry for the whole command and only gains it if this
 * resolves, so a page keeping its share of a failed command would hold a mark
 * nothing could take back.
 */
async function applyCommand(
  documentId: number,
  command: AnnotationCommand,
  onStructureChange: StructureChangeHandler,
) {
  switch (command.kind) {
    case "highlight":
      await applyHighlight(documentId, command)
      return
    case "rect":
      // One page, one annotation, so there is nothing to wind back: the command
      // either lands whole or leaves the page untouched.
      if (command.effect.kind === "none") {
        await invoke("add_pdf_rect_annotation", {
          bounds: command.bounds,
          documentId,
          pageNumber: command.pageNumber,
          style: command.style,
        })
      } else {
        await invoke("add_pdf_rect_effect_annotation", {
          bounds: command.bounds,
          documentId,
          effect: command.effect,
          pageNumber: command.pageNumber,
        })
      }
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
    case "watermark":
      if (command.config) {
        await invoke("apply_pdf_watermark", {
          config: command.config,
          documentId,
        })
      } else {
        await invoke("remove_pdf_watermark", { documentId })
      }
      return
    case "pageNumbers":
      if (command.config) {
        await invoke("apply_pdf_page_numbers", {
          config: command.config,
          documentId,
        })
      } else {
        await invoke("remove_pdf_page_numbers", { documentId })
      }
      return
    case "reorderPages":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("reorder_pdf_pages", {
          documentId,
          order: command.order,
        }),
      )
      return
    case "deletePages":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("delete_pdf_pages", {
          documentId,
          pageNumbers: command.pages,
          stashId: command.stashId,
        }),
      )
      return
    case "insertBlankPage":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("insert_pdf_blank_page", {
          documentId,
          index: command.index,
        }),
      )
      return
    case "mergeFile":
      // Only ever a redo here — the first apply reads the file through
      // `mergeFile` below. A redo restores the pages the undo stashed rather
      // than re-reading the file, which may have changed on disk since.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("restore_pdf_pages", {
          documentId,
          stashId: command.stashId,
        }),
      )
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
async function retractCommand(
  documentId: number,
  command: AnnotationCommand,
  onStructureChange: StructureChangeHandler,
) {
  switch (command.kind) {
    case "watermark":
      if (command.previous) {
        await invoke("apply_pdf_watermark", {
          config: command.previous,
          documentId,
        })
      } else {
        await invoke("remove_pdf_watermark", { documentId })
      }

      return
    case "pageNumbers":
      if (command.previous) {
        await invoke("apply_pdf_page_numbers", {
          config: command.previous,
          documentId,
        })
      } else {
        await invoke("remove_pdf_page_numbers", { documentId })
      }

      return
    case "reorderPages":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("reorder_pdf_pages", {
          documentId,
          order: command.inverse,
        }),
      )
      return
    case "deletePages":
      // Not a re-creation but a restore: the stash holds the pages themselves.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("restore_pdf_pages", {
          documentId,
          stashId: command.stashId,
        }),
      )
      return
    case "insertBlankPage":
      // The page is pristine at this point — LIFO undo has already taken back
      // anything drawn on it — but it is stashed anyway, under this entry's
      // id, which a redo's insert leaves behind and a later undo replaces.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("delete_pdf_pages", {
          documentId,
          pageNumbers: [command.index],
          stashId: command.stashId,
        }),
      )
      return
    case "mergeFile":
      // Undo a merge by deleting the range it appended, stashed under this
      // entry's id so a redo can restore exactly those bytes.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("delete_pdf_pages", {
          documentId,
          pageNumbers: mergeFilePages(command),
          stashId: command.stashId,
        }),
      )
      return
    default:
      for (const pageNumber of [...commandPages(command)].reverse()) {
        await invoke("delete_last_pdf_annotation", { documentId, pageNumber })
      }
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
  onStructureChange,
  onSuccess,
}: UseAnnotationsOptions) {
  const [history, setHistory] = useState<AnnotationHistory>(emptyHistory)
  const [renderEpochs, setRenderEpochs] = useState<RenderEpochs>({})
  const [textEpochs, setTextEpochs] = useState<RenderEpochs>({})
  const [pending, setPending] = useState(0)
  // The synchronous counterpart to `pending`: guards cannot wait for React to
  // render before deciding whether a tab may be discarded.
  const pendingRef = useRef(0)
  // How many structure edits are in flight — reorder, delete, insert, merge,
  // and undo/redo. A screen-read gesture (a grid edit, a file-card edit) must
  // not start while one runs, since it would plan against ranges the edit is
  // about to change; `isStructureBusyNow` gates on this.
  const structurePendingRef = useRef(0)
  // The subset of those that move pages that already exist — reorder, delete,
  // insert, undo/redo — but *not* a merge, which only appends and so leaves
  // every existing page where it was. A drawing or note the reader finishes
  // mid-edit is dropped only while one of these runs (its page is about to
  // move); during a merge it is let through, to land on its unmoved page once
  // the append is done, rather than silently lost.
  const pageShiftPendingRef = useRef(0)
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

  const applyEpochs = useCallback((pageNumbers: number[], textPages: number[]) => {
    setRenderEpochs((epochs) => {
      const next = { ...epochs }

      for (const pageNumber of pageNumbers) {
        next[pageNumber] = (next[pageNumber] ?? 0) + 1
      }

      return next
    })
    if (textPages.length > 0) {
      setTextEpochs((epochs) => {
        const next = { ...epochs }

        for (const pageNumber of textPages) {
          next[pageNumber] = (next[pageNumber] ?? 0) + 1
        }

        return next
      })
    }
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
      ) => {
        pages: number[]
        textPages: number[]
        work: () => Promise<boolean>
        next: AnnotationHistory
        /** For a command whose own fields are known only once its work runs — a
            merge learns the file's page count only after the backend reads it:
            rebuilds the history to commit from what work resolved. `next` is
            the placeholder used until then, and when this is absent. */
        reconcile?: () => AnnotationHistory
      } | null,
      onFailure: () => void,
    ) => {
      if (documentId === undefined) {
        return queueRef.current
      }

      const generation = generationRef.current

      pendingRef.current += 1
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
            const committed = step.reconcile ? step.reconcile() : step.next
            historyRef.current = committed
            setHistory(committed)
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
            applyEpochs(step.pages, step.textPages)
          }
        }
      })

      return queueRef.current.finally(() => {
        pendingRef.current -= 1
        setPending((count) => count - 1)
      })
    },
    [applyEpochs, documentId, onSuccess],
  )

  const commitCommand = useCallback(
    async (command: AnnotationCommand) => {
      if (documentId === undefined) {
        return
      }

      // A drawing or note carries the page it was made on; a page-moving edit
      // in flight is about to move that page, so the mark would land on the
      // wrong one. Dropped rather than misplaced — a rare gesture, one the
      // reader can simply repeat. A merge is excluded (it appends, moving
      // nothing), so a note finished while a dropped file is still merging is
      // kept, to land on its unmoved page, not lost.
      if (pageShiftPendingRef.current > 0) {
        return
      }

      await enqueue(
        (current) => ({
          next: commit(current, command),
          pages: commandPages(command),
          textPages: commandTextPages(command),
          work: async () => {
            await applyCommand(documentId, command, onStructureChange)
            return true
          },
        }),
        onAnnotateError,
      )
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  /**
   * The one path every structure edit takes: its command is planned against
   * the history the queue reached — which is what hands the stash its entry
   * id — and a plan that answers null (an identity order, an empty selection)
   * never occupies an undo step. Because the plan runs inside the queue, each
   * step is decided from the history every prior edit, its own or another's,
   * has already reached.
   *
   * Resolves with whether the edit actually *landed* — false for a plan that
   * had nothing to do *and* for one whose work failed. A caller stepping toward
   * a target (the smart-parity reconcile) stops on either, so a backend failure
   * is one attempt, not a replan of the same failing op until a loop bound.
   */
  const commitStructure = useCallback(
    async (
      plan: (
        history: AnnotationHistory,
      ) => { command: AnnotationCommand; history: AnnotationHistory } | null,
    ): Promise<boolean> => {
      if (documentId === undefined) {
        return false
      }

      let landed = false

      structurePendingRef.current += 1
      pageShiftPendingRef.current += 1

      try {
        await enqueue((current) => {
          const step = plan(current)

          if (!step) {
            return null
          }

          return {
            next: step.history,
            pages: commandPages(step.command),
            textPages: commandTextPages(step.command),
            work: async () => {
              await applyCommand(documentId, step.command, onStructureChange)
              landed = true
              return true
            },
          }
        }, onAnnotateError)
      } finally {
        structurePendingRef.current -= 1
        pageShiftPendingRef.current -= 1
      }

      return landed
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  const reorderPages = useCallback(
    (order: number[]) => commitStructure((current) => planReorderPages(current, order)),
    [commitStructure],
  )

  const deletePages = useCallback(
    (pages: number[], pageCount: number) =>
      commitStructure((current) => planDeletePages(current, pages, pageCount)),
    [commitStructure],
  )

  const insertBlankPage = useCallback(
    (index: number, pageCount: number, pad = false) =>
      commitStructure((current) => planInsertBlankPage(current, index, pageCount, pad)),
    [commitStructure],
  )

  /**
   * Appends another PDF's pages to the document. Unlike every other structure
   * edit this cannot go through `commitStructure`: the file's page count is
   * unknown until the backend reads it, so the first apply reads the file here
   * and `reconcile` writes what it learned back into the freshly committed
   * command. A redo — the command already carries its counts by then — restores
   * the stashed pages through `applyCommand` like any other.
   */
  const mergeFile = useCallback(
    async (path: string, name: string) => {
      if (documentId === undefined) {
        return
      }

      structurePendingRef.current += 1

      try {
        await enqueue((current) => {
          const planned = planMergeFile(current, path, name)
          const entryId = planned.history.past.at(-1)!.id
          let outcome: PdfMergeOutcome | null = null

          return {
            next: planned.history,
            pages: [],
            textPages: [],
            work: async () => {
              outcome = await invoke<PdfMergeOutcome>("merge_pdf_from_path", {
                documentId,
                path,
              })
              onStructureChange(documentId, outcome.update)
              return true
            },
            reconcile: () =>
              outcome
                ? fillMergeOutcome(
                    planned.history,
                    entryId,
                    outcome.insertedAt,
                    outcome.pageCount,
                  )
                : planned.history,
          }
        }, onAnnotateError)
      } finally {
        structurePendingRef.current -= 1
      }
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  /**
   * Plans against the history the shared queue has actually reached, and
   * reports whether the change landed — the dialog stays open on a refusal
   * rather than closing over an error the reader would have to hunt for.
   */
  const setWatermark = useCallback(
    async (config: WatermarkConfig | null, pageCount: number) => {
      if (documentId === undefined) {
        return false
      }

      let failed = false

      await enqueue((current) => {
        const planned = planWatermarkChange(current, config, pageCount)

        if (!planned) {
          return null
        }
        const { command } = planned
        const pages = commandPages(command)

        return {
          next: planned.history,
          pages,
          textPages: pages,
          work: async () => {
            await applyCommand(documentId, command, onStructureChange)
            return true
          },
        }
      }, () => {
        failed = true
        onAnnotateError()
      })

      return !failed
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  /** The page-number counterpart of `setWatermark`, planned against the history
      the shared queue has reached; reports whether the change landed. */
  const setPageNumbers = useCallback(
    async (config: PageNumbersConfig | null, pageCount: number) => {
      if (documentId === undefined) {
        return false
      }

      let failed = false

      await enqueue((current) => {
        const planned = planPageNumbersChange(current, config, pageCount)

        if (!planned) {
          return null
        }
        const { command } = planned
        const pages = commandPages(command)

        return {
          next: planned.history,
          pages,
          textPages: pages,
          work: async () => {
            await applyCommand(documentId, command, onStructureChange)
            return true
          },
        }
      }, () => {
        failed = true
        onAnnotateError()
      })

      return !failed
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  // Undo and redo count as page-shifting: the entry they take back may be a
  // structure edit, and a page-numbered command queued behind it would go
  // stale. Blocked conservatively rather than by peeking at the command, which
  // a pending edit could still change before the queue reaches this step.
  const undoCommand = useCallback(async () => {
    if (documentId === undefined) {
      return
    }

    structurePendingRef.current += 1
    pageShiftPendingRef.current += 1

    try {
      await enqueue((current) => {
        const step = undo(current)

        return step
          ? {
              next: step.history,
              pages: commandPages(step.entry.command),
              textPages: commandTextPages(step.entry.command),
              work: async () => {
                await retractCommand(documentId, step.entry.command, onStructureChange)
                return true
              },
            }
          : null
      }, onAnnotateError)
    } finally {
      structurePendingRef.current -= 1
      pageShiftPendingRef.current -= 1
    }
  }, [documentId, enqueue, onAnnotateError, onStructureChange])

  const redoCommand = useCallback(async () => {
    if (documentId === undefined) {
      return
    }

    structurePendingRef.current += 1
    pageShiftPendingRef.current += 1

    try {
      await enqueue((current) => {
        const step = redo(current)

        return step
          ? {
              next: step.history,
              pages: commandPages(step.entry.command),
              textPages: commandTextPages(step.entry.command),
              work: async () => {
                await applyCommand(documentId, step.entry.command, onStructureChange)
                return true
              },
            }
          : null
      }, onAnnotateError)
    } finally {
      structurePendingRef.current -= 1
      pageShiftPendingRef.current -= 1
    }
  }, [documentId, enqueue, onAnnotateError, onStructureChange])

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
          textPages: [],
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
              textPages: [],
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

  /** Whether any structure edit — including a merge — is in flight this instant.
      The guard a screen-read gesture (a grid or file-card edit) checks so it
      never plans against ranges an edit is about to change. Drawings and notes
      use the narrower page-shift guard instead, since a merge cannot misplace
      them. */
  const hasPendingWorkNow = useCallback(() => pendingRef.current > 0, [])
  const isStructureBusyNow = useCallback(() => structurePendingRef.current > 0, [])

  /**
   * The applied history as of this instant, off the ref rather than the
   * rendered state. Awaited file operations resolve after the ref moves but
   * before the re-render, so a follow-up that needs the fresh ranges — the
   * smart-parity reconcile — has to read it here, not from `history`.
   */
  const historyNow = useCallback(() => historyRef.current, [])

  const reset = useCallback(() => {
    generationRef.current += 1
    historyRef.current = emptyHistory
    setHistory(emptyHistory)
    setRenderEpochs({})
    setTextEpochs({})
  }, [])

  const isBusy = pending > 0

  return useMemo(
    () => ({
      canRedo: canRedo(history) && !isBusy,
      canUndo: canUndo(history) && !isBusy,
      commit: commitCommand,
      // The generic structure-edit path, exposed so the smart-parity reconcile
      // can re-derive each pad step inside the queue rather than from a snapshot
      // an interleaved edit could invalidate.
      commitStructure,
      deletePages,
      exportCopy,
      hasPendingWorkNow,
      // The applied command history itself, so the owner can derive the file
      // ranges (which need the initial file's name and page count, known only
      // to it) the way it derives the watermark config here.
      history,
      historyNow,
      insertBlankPage,
      isDirty: isDirty(history),
      isDirtyNow,
      isStructureBusyNow,
      mergeFile,
      pageNumbersConfig: currentPageNumbersConfig(history),
      redo: redoCommand,
      reorderPages,
      renderEpochs,
      reset,
      save,
      setPageNumbers,
      setWatermark,
      textEpochs,
      undo: undoCommand,
      watermarkConfig: currentWatermarkConfig(history),
    }),
    [
      commitCommand,
      commitStructure,
      deletePages,
      exportCopy,
      hasPendingWorkNow,
      history,
      historyNow,
      insertBlankPage,
      isBusy,
      isDirtyNow,
      isStructureBusyNow,
      mergeFile,
      redoCommand,
      renderEpochs,
      reorderPages,
      reset,
      save,
      setPageNumbers,
      setWatermark,
      textEpochs,
      undoCommand,
    ],
  )
}
