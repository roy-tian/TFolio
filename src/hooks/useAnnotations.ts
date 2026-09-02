import { useCallback, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

import {
  canRedo,
  canUndo,
  commandPages,
  commandTextPages,
  commit,
  emptyHistory,
  fillInsertFileOutcome,
  insertFilePages,
  isDirty,
  markSaved,
  pageNumbersConfig as currentPageNumbersConfig,
  planDeletePages,
  planInsertBlankPage,
  planInsertFile,
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
  PdfInsertOutcome,
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
  /** `command` is the edit that failed, where re-running it is the whole
      recovery — a note whose text would otherwise be lost with the editor that
      held it. Absent for a refusal there is nothing to hold on to. */
  onAnnotateError: (error?: unknown, command?: AnnotationCommand) => void
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
      // either lands whole or leaves the page untouched. A translucent block is
      // a drawn shape while a blur or a mosaic is built from the page's own
      // pixels, so each takes the backend path that suits it.
      if (command.style.effect === "translucent") {
        await invoke("add_pdf_rect_annotation", {
          bounds: command.bounds,
          documentId,
          pageNumber: command.pageNumber,
          style: {
            color: command.style.color,
            opacity: command.style.opacity,
          },
        })
      } else {
        await invoke("add_pdf_rect_effect_annotation", {
          bounds: command.bounds,
          documentId,
          effect: {
            kind: command.style.effect,
            strength: command.style.strength,
          },
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
    case "insertFile":
      // Only ever a redo here — the first apply reads the file through
      // `insertFile` below. A redo restores the pages the undo stashed rather
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
    case "insertFile":
      // Undo an insert by deleting the range it brought in, stashed under this
      // entry's id so a redo can restore exactly those bytes.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("delete_pdf_pages", {
          documentId,
          pageNumbers: insertFilePages(command),
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
  // How many page-moving edits are in flight — reorder, delete, insert, and
  // undo/redo. Two gestures must wait on this. A screen-read one (a grid edit)
  // must not start while one runs, since it would plan against positions the
  // edit is about to change; `isStructureBusyNow` gates on that. And a drawing
  // or note the reader finishes while one runs is dropped rather than
  // misplaced: the page it is anchored to by number is about to become a
  // different page.
  const structurePendingRef = useRef(0)
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
        /** For a command whose own fields are known only once its work runs —
            an insert learns the file's page count only after the backend reads
            it: rebuilds the history to commit from what work resolved. `next` is
            the placeholder used until then, and when this is absent. */
        reconcile?: () => AnnotationHistory
      } | null,
      onFailure: (error: unknown) => void,
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
        } catch (error) {
          // Carried rather than swallowed: one refusal — nothing installed can
          // draw this text — is the reader's to act on, and only the error
          // itself says which one it was.
          if (generation === generationRef.current) {
            onFailure(error)
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
      // reader can simply repeat.
      if (structurePendingRef.current > 0) {
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
        (error) => onAnnotateError(error, command),
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
   * had nothing to do *and* for one whose work failed.
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
    (index: number, pageCount: number) =>
      commitStructure((current) => planInsertBlankPage(current, index, pageCount)),
    [commitStructure],
  )

  /**
   * Inserts another PDF's pages at `index`. Unlike every other structure edit
   * this cannot go through `commitStructure`: the file's page count is unknown
   * until the backend reads it, so the first apply reads the file here and
   * `reconcile` writes what it learned back into the freshly committed command.
   * A redo — the command already carries its count by then — restores the
   * stashed pages through `applyCommand` like any other.
   *
   * Resolves with how many pages the file actually brought — 0 for a refused
   * position and for a read that failed — which is what a caller inserting a
   * run of files advances by. The document's own growth would answer the same
   * question with anything else that landed in between folded in.
   */
  const insertFile = useCallback(
    async (path: string, index: number, pageCount: number) => {
      if (documentId === undefined) {
        return 0
      }

      let inserted = 0

      structurePendingRef.current += 1

      try {
        await enqueue((current) => {
          const planned = planInsertFile(current, path, index, pageCount)

          if (!planned) {
            // A position the document does not have — the grid the gap was read
            // off has since been renumbered. Nothing to apply, so say so here:
            // a null plan reaches neither the success nor the failure path.
            onAnnotateError()
            return null
          }

          const entryId = planned.history.past.at(-1)!.id
          let outcome: PdfInsertOutcome | null = null

          return {
            next: planned.history,
            // Every page from the gap on shows different content afterwards;
            // the pages past the old end are new components that fetch on mount.
            pages: commandPages(planned.command),
            textPages: commandTextPages(planned.command),
            work: async () => {
              outcome = await invoke<PdfInsertOutcome>("insert_pdf_from_path", {
                documentId,
                index,
                path,
              })
              onStructureChange(documentId, outcome.update)
              inserted = outcome.pageCount
              return true
            },
            reconcile: () =>
              outcome
                ? fillInsertFileOutcome(planned.history, entryId, outcome.pageCount)
                : planned.history,
          }
        }, onAnnotateError)
      } finally {
        structurePendingRef.current -= 1
      }

      return inserted
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
      }, (error) => {
        failed = true
        onAnnotateError(error)
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
      }, (error) => {
        failed = true
        onAnnotateError(error)
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
    }
  }, [documentId, enqueue, onAnnotateError, onStructureChange])

  const redoCommand = useCallback(async () => {
    if (documentId === undefined) {
      return
    }

    structurePendingRef.current += 1

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

  /** Whether any structure edit is in flight this instant. The guard a
      screen-read gesture (a grid edit) checks so it never plans against
      positions an edit is about to change. */
  const hasPendingWorkNow = useCallback(() => pendingRef.current > 0, [])
  const isStructureBusyNow = useCallback(() => structurePendingRef.current > 0, [])

  /**
   * The applied history as of this instant, off the ref rather than the
   * rendered state. Awaited file operations resolve after the ref moves but
   * before the re-render, so a follow-up that needs the fresh history — the
   * toolbar's undo, deciding whether the step it is about to take moves pages —
   * has to read it here, not from `history`.
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
      deletePages,
      exportCopy,
      hasPendingWorkNow,
      historyNow,
      insertBlankPage,
      insertFile,
      isDirty: isDirty(history),
      isDirtyNow,
      isStructureBusyNow,
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
      deletePages,
      exportCopy,
      hasPendingWorkNow,
      history,
      historyNow,
      insertBlankPage,
      insertFile,
      isBusy,
      isDirtyNow,
      isStructureBusyNow,
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
