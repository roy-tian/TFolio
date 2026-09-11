import { useCallback, useMemo, useRef, useState } from "react"
import { Channel, invoke } from "@tauri-apps/api/core"

import {
  canRedo,
  canUndo,
  commandPages,
  commandTextPages,
  commit,
  emptyHistory,
  fillErasedPages,
  fillInsertFileOutcome,
  insertFilePages,
  insertPagesRange,
  isDirty,
  markSaved,
  nextRedoCommand,
  nextUndoCommand,
  pageNumbersConfig as currentPageNumbersConfig,
  planDeletePages,
  planDuplicatePages,
  planEraseAnnotation,
  planInsertBlankPage,
  planInsertFile,
  planInsertPages,
  planPageNumbersChange,
  planReorderPages,
  planRotatePages,
  planWatermarkChange,
  redo,
  retargetCommand,
  undo,
  watermarkConfig as currentWatermarkConfig,
  type AnnotationCommand,
  type AnnotationHistory,
  type HighlightCommand,
  type RenderEpochs,
} from "@/lib/annotations"
import type { PagePoint } from "@/lib/annotationGeometry"
import { e2eOverride } from "@/lib/e2e"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import type {
  PdfExportOutcome,
  PdfInsertOutcome,
  PdfStructureUpdate,
} from "@/lib/pdf"
import {
  PdfOperationCancelled,
  type PdfLayerOutcome,
  type PdfProgress,
} from "@/lib/progress"
import type { WatermarkConfig } from "@/lib/watermark"

type ProgressHandler = (progress: PdfProgress) => void

/** A command channel that is kept for the duration of its invoke call. */
function progressChannel(onProgress?: ProgressHandler) {
  const channel = new Channel<PdfProgress>()

  channel.onmessage = onProgress ?? (() => undefined)
  return channel
}

/**
 * How a structure command left the page list: an array is new slot -> previous
 * page number, for existing pages that only moved; `"inPlace"` is an edit that
 * moved nothing at all, and so leaves everything held by page number — the
 * selection, the clipboard, the grid's own identities — still true.
 */
type PageMovement = number[] | "inPlace"

/** Where a structure command's fresh metadata lands, applied or undone. */
type StructureChangeHandler = (
  documentId: number,
  update: PdfStructureUpdate,
  movement?: PageMovement,
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
 * The marks each applied history entry put on the document, by entry id.
 *
 * PDFium owns the annotations themselves; these are only the handles it answers
 * to, which nothing in the history could work out for itself — and which are
 * what let a mark be taken off wherever it has come to sit, rather than only
 * from the end of its page.
 */
type MarkStore = Map<number, number[]>

/** The entry whose command put mark `markId` on the page, if it is still
    applied — how the eraser turns a hit test into a history entry. */
function entryForMark(marks: MarkStore, markId: number) {
  for (const [entryId, ids] of marks) {
    if (ids.includes(markId)) {
      return entryId
    }
  }

  return undefined
}

/** Takes an entry's marks off the document and forgets them, reporting the
    pages the backend found them on. */
async function removeMarks(
  documentId: number,
  entryId: number,
  marks: MarkStore,
): Promise<number[]> {
  const markIds = marks.get(entryId)

  if (!markIds || markIds.length === 0) {
    return []
  }

  const pages = await invoke<number[]>("delete_pdf_annotations", {
    documentId,
    markIds,
  })

  marks.delete(entryId)

  return pages
}

/**
 * A command that fails partway is wound back rather than left where it stopped:
 * the history holds one entry for the whole command and only gains it if this
 * resolves, so a page keeping its share of a failed command would hold a mark
 * nothing could take back.
 *
 * Marks the command creates are recorded under `entryId`, and marks it removes
 * are forgotten; the pages the backend reports it touched come back, since a
 * command's own page numbers are the ones it was made with.
 */
async function applyCommand(
  documentId: number,
  entryId: number,
  command: AnnotationCommand,
  onStructureChange: StructureChangeHandler,
  marks: MarkStore,
  onProgress?: ProgressHandler,
): Promise<number[]> {
  switch (command.kind) {
    case "highlight":
      marks.set(entryId, await applyHighlight(documentId, command))
      return []
    case "rect":
      // One page, one annotation, so there is nothing to wind back: the command
      // either lands whole or leaves the page untouched. A translucent block is
      // a drawn shape while a blur or a mosaic is built from the page's own
      // pixels, so each takes the backend path that suits it.
      marks.set(entryId, [
        command.style.effect === "translucent"
          ? await invoke<number>("add_pdf_rect_annotation", {
              bounds: command.bounds,
              documentId,
              pageNumber: command.pageNumber,
              style: {
                color: command.style.color,
                opacity: command.style.opacity,
              },
            })
          : await invoke<number>("add_pdf_rect_effect_annotation", {
              bounds: command.bounds,
              documentId,
              effect: {
                kind: command.style.effect,
                strength: command.style.strength,
              },
              pageNumber: command.pageNumber,
            }),
      ])
      return []
    case "textNote":
      // One page and one annotation, as a rectangle is.
      marks.set(entryId, [
        await invoke<number>("add_pdf_text_note_annotation", {
          documentId,
          origin: command.origin,
          pageNumber: command.pageNumber,
          style: command.style,
          text: command.text,
        }),
      ])
      return []
    case "eraseAnnotation":
      // The marks go, the entry that made them is already out of the applied
      // history, and what comes back is where they were — which is what puts
      // them back in the right place should this be undone.
      return await removeMarks(documentId, command.target.id, marks)
    case "watermark":
      if (command.config) {
        await runOwnedLayerCommand("apply_pdf_watermark", {
          config: command.config,
          documentId,
          onProgress: progressChannel(onProgress),
        })
      } else {
        await runOwnedLayerCommand("remove_pdf_watermark", {
          documentId,
          onProgress: progressChannel(onProgress),
        })
      }
      return []
    case "pageNumbers":
      if (command.config) {
        await runOwnedLayerCommand("apply_pdf_page_numbers", {
          config: command.config,
          documentId,
          onProgress: progressChannel(onProgress),
        })
      } else {
        await runOwnedLayerCommand("remove_pdf_page_numbers", {
          documentId,
          onProgress: progressChannel(onProgress),
        })
      }
      return []
    case "reorderPages":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("reorder_pdf_pages", {
          documentId,
          order: command.order,
        }),
        command.order,
      )
      return []
    case "rotatePages":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("rotate_pdf_pages", {
          degrees: command.degrees,
          documentId,
          pageNumbers: command.pages,
        }),
        "inPlace",
      )
      return []
    case "deletePages":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("delete_pdf_pages", {
          documentId,
          pageNumbers: command.pages,
          stashId: command.stashId,
        }),
      )
      return []
    case "insertBlankPage":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("insert_pdf_blank_page", {
          documentId,
          index: command.index,
        }),
      )
      return []
    case "insertFile":
    case "insertPages":
    case "duplicatePages":
      // Only ever a redo here — the first apply reads the pages across through
      // `insertFile`/`insertPages` below. A redo restores what the undo stashed
      // rather than re-reading a file, or a document, that may have moved on.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("restore_pdf_pages", {
          documentId,
          stashId: command.stashId,
        }),
      )
      return []
  }
}

/**
 * Runs one of the two owned-layer commands, which answer whether the change
 * landed rather than merely succeeding.
 *
 * `false` is the reader having stopped a long run: the backend has already put
 * the document back as it was, so the step must leave no history entry either —
 * which is what throwing gets, the queue committing nothing that threw.
 */
async function runOwnedLayerCommand(
  command: string,
  args: Record<string, unknown>,
) {
  if (!(await invoke<boolean>(command, args))) {
    throw new PdfOperationCancelled()
  }
}

/** The marks it made, one per page the selection ran across, in that order. */
async function applyHighlight(documentId: number, command: HighlightCommand) {
  const written: number[] = []

  try {
    for (const target of command.targets) {
      written.push(
        await invoke<number>("add_pdf_highlight_annotation", {
          color: command.color,
          documentId,
          opacity: command.opacity,
          pageNumber: target.pageNumber,
          quads: target.quads,
        }),
      )
    }
  } catch (error) {
    if (written.length > 0) {
      await invoke("delete_pdf_annotations", {
        documentId,
        markIds: written,
      }).catch(() => undefined)
    }

    throw error
  }

  return written
}

/**
 * The inverse of `applyCommand`: a mark is taken off by the ids its apply
 * recorded, so an undo finds its own annotations wherever the eraser has left
 * them sitting on the page. Reports the pages the backend touched, as an apply
 * does.
 */
async function retractCommand(
  documentId: number,
  entryId: number,
  command: AnnotationCommand,
  onStructureChange: StructureChangeHandler,
  marks: MarkStore,
): Promise<number[]> {
  switch (command.kind) {
    case "watermark":
      if (command.previous) {
        await runOwnedLayerCommand("apply_pdf_watermark", {
          config: command.previous,
          documentId,
          onProgress: progressChannel(),
        })
      } else {
        await runOwnedLayerCommand("remove_pdf_watermark", {
          documentId,
          onProgress: progressChannel(),
        })
      }

      return []
    case "pageNumbers":
      if (command.previous) {
        await runOwnedLayerCommand("apply_pdf_page_numbers", {
          config: command.previous,
          documentId,
          onProgress: progressChannel(),
        })
      } else {
        await runOwnedLayerCommand("remove_pdf_page_numbers", {
          documentId,
          onProgress: progressChannel(),
        })
      }

      return []
    case "reorderPages":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("reorder_pdf_pages", {
          documentId,
          order: command.inverse,
        }),
        command.inverse,
      )
      return []
    case "rotatePages":
      // The rest of the way round, which is what puts each page back however
      // far it was turned to begin with.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("rotate_pdf_pages", {
          degrees: 360 - command.degrees,
          documentId,
          pageNumbers: command.pages,
        }),
        "inPlace",
      )
      return []
    case "deletePages":
      // Not a re-creation but a restore: the stash holds the pages themselves.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("restore_pdf_pages", {
          documentId,
          stashId: command.stashId,
        }),
      )
      return []
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
      return []
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
      return []
    case "insertPages":
    case "duplicatePages":
      // The same undo, over the block the drag or the paste brought in.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("delete_pdf_pages", {
          documentId,
          pageNumbers: insertPagesRange(command),
          stashId: command.stashId,
        }),
      )
      return []
    case "eraseAnnotation":
      // Undoing an erase is applying the mark's own command again, aimed at the
      // pages the marks were really on rather than the ones the command was
      // first made with. PDFium only appends, so it lands at the end of each
      // page's annotations rather than back among them: the history is exact,
      // and so is every other entry's undo — which knows its own marks by id —
      // but a mark that was under another comes back over it.
      await applyCommand(
        documentId,
        command.target.id,
        retargetCommand(command.target.command, command.pages),
        onStructureChange,
        marks,
      )

      return []
    default:
      return await removeMarks(documentId, entryId, marks)
  }
}

/**
 * The document PDFium holds is the truth about what is on a page, so nothing
 * here mirrors the annotations. This keeps only what PDFium cannot answer: what
 * the reader did, in what order, how much they have taken back — and which of
 * PDFium's marks each of those steps is holding, which is a handle rather than
 * a copy.
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
  // Commit receipts need the queue's exact epoch, before React renders it.
  const renderEpochsRef = useRef<RenderEpochs>({})
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
  // The one thing about the annotations themselves this has to keep: which of
  // the backend's marks each applied entry is holding, so an undo and the
  // eraser can name them rather than count them off the end of a page.
  const marksRef = useRef<MarkStore>(new Map())

  const applyEpochs = useCallback((pageNumbers: number[], textPages: number[]) => {
    const next = { ...renderEpochsRef.current }

    for (const pageNumber of pageNumbers) {
      next[pageNumber] = (next[pageNumber] ?? 0) + 1
    }

    renderEpochsRef.current = next
    setRenderEpochs(next)
    if (textPages.length > 0) {
      setTextEpochs((epochs) => {
        const next = { ...epochs }

        for (const pageNumber of textPages) {
          next[pageNumber] = (next[pageNumber] ?? 0) + 1
        }

        return next
      })
    }
    return next
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
        /** Pages only the backend can name — the ones a mark turned out to be
            on, which a structure edit may have renumbered since the command
            that made it. Redrawn alongside `pages`. */
        touched?: () => number[]
        /** Identifies the first bitmap request that includes this commit. */
        onApplied?: (epochs: RenderEpochs) => void
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

        let happened = false
        try {
          happened = await step.work()

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
            const epochs = applyEpochs(
              [...step.pages, ...(step.touched?.() ?? [])],
              step.textPages,
            )
            if (happened) {
              step.onApplied?.(epochs)
            }
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
    async (
      command: AnnotationCommand,
      onApplied?: (epochs: RenderEpochs) => void,
    ) => {
      if (documentId === undefined) {
        return false
      }

      // A drawing or note carries the page it was made on; a page-moving edit
      // in flight is about to move that page, so the mark would land on the
      // wrong one. Dropped rather than misplaced — a rare gesture, one the
      // reader can simply repeat.
      if (structurePendingRef.current > 0) {
        return false
      }

      let applied = false
      await enqueue(
        (current) => ({
          onApplied: (epochs) => {
            applied = true
            onApplied?.(epochs)
          },
          next: commit(current, command),
          pages: commandPages(command),
          textPages: commandTextPages(command),
          work: async () => {
            // `commit` gives the entry `nextId`; the marks are filed under it.
            await applyCommand(
              documentId,
              current.nextId,
              command,
              onStructureChange,
              marksRef.current,
            )

            return true
          },
        }),
        (error) => onAnnotateError(error, command),
      )
      return applied
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
              await applyCommand(
                documentId,
                current.nextId,
                step.command,
                onStructureChange,
                marksRef.current,
              )
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

  const rotatePages = useCallback(
    (pages: number[], degrees: number) =>
      commitStructure((current) => planRotatePages(current, pages, degrees)),
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
   * Copies `sourcePages` out of another open document into this one at `index`
   * — a thumbnail drag that crossed to this document's tab. Like `insertFile`
   * it cannot go through `commitStructure`, whose apply path is the redo's:
   * the first apply reads the pages across, and only a redo restores the stash.
   *
   * The pages are the source grid's own numbers and the position is this grid's,
   * both read off the screen — which is why the caller, like every other grid
   * gesture, declines a drop while a page-shifting edit is in flight.
   */
  const insertPages = useCallback(
    async (
      sourceDocumentId: number,
      sourcePages: number[],
      index: number,
      pageCount: number,
    ) => {
      if (documentId === undefined) {
        return false
      }

      let landed = false

      structurePendingRef.current += 1

      try {
        await enqueue((current) => {
          const planned = planInsertPages(
            current,
            sourceDocumentId,
            sourcePages,
            index,
            pageCount,
          )

          if (!planned) {
            // A position this document does not have — the grid the gap was
            // read off has since been renumbered. A null plan reaches neither
            // the success nor the failure path, so it is said here.
            onAnnotateError()
            return null
          }

          return {
            next: planned.history,
            pages: commandPages(planned.command),
            textPages: commandTextPages(planned.command),
            work: async () => {
              onStructureChange(
                documentId,
                await invoke<PdfStructureUpdate>(
                  "insert_pdf_pages_from_document",
                  {
                    documentId,
                    index,
                    // The plan's own block: sorted and deduplicated, so the
                    // range the undo deletes is the one the backend copied.
                    pageNumbers: planned.command.sourcePages,
                    sourceDocumentId,
                  },
                ),
              )
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

  /**
   * Copies this document's own `sourcePages` back into it at `index` — the
   * grid's paste. It takes `insertPages`' path rather than `commitStructure`'s
   * for the same reason: there the apply *is* the redo, and a redo of a paste
   * restores the pages its undo stashed instead of copying them a second time.
   */
  const duplicatePages = useCallback(
    async (sourcePages: number[], index: number, pageCount: number) => {
      if (documentId === undefined) {
        return false
      }

      let landed = false

      structurePendingRef.current += 1

      try {
        await enqueue((current) => {
          const planned = planDuplicatePages(
            current,
            sourcePages,
            index,
            pageCount,
          )

          if (!planned) {
            // A page or a position this document no longer has: the grid both
            // were read off has since been renumbered. A null plan reaches
            // neither the success nor the failure path, so it is said here.
            onAnnotateError()
            return null
          }

          return {
            next: planned.history,
            pages: commandPages(planned.command),
            textPages: commandTextPages(planned.command),
            work: async () => {
              onStructureChange(
                documentId,
                await invoke<PdfStructureUpdate>("duplicate_pdf_pages", {
                  documentId,
                  index,
                  // The plan's own block: sorted and deduplicated, so the range
                  // the undo deletes is the one the backend copied.
                  pageNumbers: planned.command.sourcePages,
                }),
              )
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

  /**
   * Rubs out whichever of this session's marks lies under `point` on
   * `pageNumber`; a point on nothing of the reader's own leaves the document
   * alone, and so leaves the history alone too.
   *
   * The hit test is the backend's because the annotations are: the history
   * records what was asked for, not the box PDFium gave it. It runs ahead of
   * the queue rather than inside it — a mark another queued step takes away
   * first simply no longer answers to its entry, and the plan finds nothing to
   * erase.
   */
  const eraseAt = useCallback(
    async (pageNumber: number, point: PagePoint) => {
      // The same guard a drawing takes: a page-moving edit in flight is about
      // to renumber the page this hit test would name.
      if (documentId === undefined || structurePendingRef.current > 0) {
        return
      }

      let markId: number | null

      try {
        markId = await invoke<number | null>("pdf_annotation_at_point", {
          documentId,
          pageNumber,
          point,
        })
      } catch (error) {
        onAnnotateError(error)
        return
      }

      if (markId === null) {
        return
      }

      const target = markId

      await enqueue((current) => {
        const entryId = entryForMark(marksRef.current, target)

        if (entryId === undefined) {
          return null
        }

        const planned = planEraseAnnotation(current, entryId)

        if (!planned) {
          return null
        }

        const eraseId = planned.history.past.at(-1)!.id
        let reported: number[] = []

        return {
          next: planned.history,
          // Where the mark was made; where it actually was comes back from the
          // work itself, and both are redrawn.
          pages: commandPages(planned.command),
          textPages: [],
          touched: () => reported,
          work: async () => {
            reported = await applyCommand(
              documentId,
              eraseId,
              planned.command,
              onStructureChange,
              marksRef.current,
            )

            return true
          },
          reconcile: () => fillErasedPages(planned.history, eraseId, reported),
        }
      }, onAnnotateError)
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  /**
   * Plans against the history the shared queue has actually reached, and
   * reports whether the change landed — the dialog stays open on a refusal
   * rather than closing over an error the reader would have to hunt for.
   */
  const setWatermark = useCallback(
    async (
      config: WatermarkConfig | null,
      pageCount: number,
      onProgress?: ProgressHandler,
    ): Promise<PdfLayerOutcome> => {
      if (documentId === undefined) {
        return "failed"
      }

      let outcome: PdfLayerOutcome = "applied"

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
            await applyCommand(
              documentId,
              current.nextId,
              command,
              onStructureChange,
              marksRef.current,
              onProgress,
            )

            return true
          },
        }
      }, (error) => {
        // A stop is the reader's own doing: nothing to report, and nothing for
        // the dialog to stay open over.
        if (error instanceof PdfOperationCancelled) {
          outcome = "cancelled"
          return
        }

        outcome = "failed"
        onAnnotateError(error)
      })

      return outcome
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  /** The page-number counterpart of `setWatermark`, planned against the history
      the shared queue has reached; reports how the change ended. */
  const setPageNumbers = useCallback(
    async (
      config: PageNumbersConfig | null,
      pageCount: number,
      onProgress?: ProgressHandler,
    ): Promise<PdfLayerOutcome> => {
      if (documentId === undefined) {
        return "failed"
      }

      let outcome: PdfLayerOutcome = "applied"

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
            await applyCommand(
              documentId,
              current.nextId,
              command,
              onStructureChange,
              marksRef.current,
              onProgress,
            )

            return true
          },
        }
      }, (error) => {
        if (error instanceof PdfOperationCancelled) {
          outcome = "cancelled"
          return
        }

        outcome = "failed"
        onAnnotateError(error)
      })

      return outcome
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  /**
   * Asks the backend to stop the watermark or page-number work now running on
   * this document, which then rolls it back to the bytes it started from.
   *
   * The one gesture that reaches a rebuild already in flight: everything else
   * the reader can do queues behind the PDFium lock that rebuild is holding,
   * which on a long document is exactly the wait they are trying to leave.
   *
   * Answers whether the backend found a run to stop. `false` is not a failure
   * but a miss — the ask arrived before the command listed itself, which the
   * caller has to repeat rather than drop, or the reader's stop is silently
   * spent and the run they walked out of lands anyway.
   */
  const cancelOperation = useCallback(async () => {
    if (documentId === undefined) {
      return false
    }

    try {
      return await invoke<boolean>("cancel_pdf_operation", { documentId })
    } catch {
      // Nothing to report: the work either stops or finishes, and both are
      // already answered by the operation's own result.
      return false
    }
  }, [documentId])

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

        if (!step) {
          return null
        }

        let reported: number[] = []

        return {
          next: step.history,
          pages: commandPages(step.entry.command),
          textPages: commandTextPages(step.entry.command),
          touched: () => reported,
          work: async () => {
            reported = await retractCommand(
              documentId,
              step.entry.id,
              step.entry.command,
              onStructureChange,
              marksRef.current,
            )

            return true
          },
        }
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

        if (!step) {
          return null
        }

        let reported: number[] = []

        return {
          next: step.history,
          pages: commandPages(step.entry.command),
          textPages: commandTextPages(step.entry.command),
          touched: () => reported,
          work: async () => {
            reported = await applyCommand(
              documentId,
              step.entry.id,
              step.entry.command,
              onStructureChange,
              marksRef.current,
            )

            return true
          },
        }
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
            const args = { documentId, filterLabel, suggestedName }
            const override = e2eOverride("exportPdf")
            const outcome = override
              ? await override(args)
              : await invoke<PdfExportOutcome | null>("export_pdf", args)

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
    marksRef.current = new Map()
    setHistory(emptyHistory)
    setRenderEpochs({})
    renderEpochsRef.current = {}
    setTextEpochs({})
  }, [])

  const isBusy = pending > 0

  return useMemo(
    () => ({
      canRedo: canRedo(history) && !isBusy,
      canUndo: canUndo(history) && !isBusy,
      cancelOperation,
      commit: commitCommand,
      deletePages,
      duplicatePages,
      eraseAt,
      exportCopy,
      hasPendingWorkNow,
      historyNow,
      insertBlankPage,
      insertFile,
      insertPages,
      isDirty: isDirty(history),
      isDirtyNow,
      isStructureBusyNow,
      nextRedo: nextRedoCommand(history),
      nextUndo: nextUndoCommand(history),
      pageNumbersConfig: currentPageNumbersConfig(history),
      redo: redoCommand,
      reorderPages,
      renderEpochs,
      reset,
      rotatePages,
      save,
      setPageNumbers,
      setWatermark,
      textEpochs,
      undo: undoCommand,
      watermarkConfig: currentWatermarkConfig(history),
    }),
    [
      cancelOperation,
      commitCommand,
      deletePages,
      duplicatePages,
      eraseAt,
      exportCopy,
      hasPendingWorkNow,
      history,
      historyNow,
      insertBlankPage,
      insertFile,
      insertPages,
      isBusy,
      isDirtyNow,
      isStructureBusyNow,
      redoCommand,
      renderEpochs,
      reorderPages,
      reset,
      rotatePages,
      save,
      setPageNumbers,
      setWatermark,
      textEpochs,
      undoCommand,
    ],
  )
}
