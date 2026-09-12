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

/** An array maps new slot -> previous page number for pages that only moved;
    `"inPlace"` moved nothing, so everything held by page number stays true. */
type PageMovement = number[] | "inPlace"

type StructureChangeHandler = (
  documentId: number,
  update: PdfStructureUpdate,
  movement?: PageMovement,
) => void

type UseAnnotationsOptions = {
  documentId: number | undefined
  /** `command` is the edit that failed, where re-running it is the recovery —
      a note otherwise lost with the editor that held it. Absent for a refusal. */
  onAnnotateError: (error?: unknown, command?: AnnotationCommand) => void
  onExportError: () => void
  onExported: (documentId: number, outcome: PdfExportOutcome) => void
  onSaveError: () => void
  onStructureChange: StructureChangeHandler
  onSuccess: () => void
}

/** Which of PDFium's marks each applied entry holds, by entry id — handles the
    history cannot derive, so a mark can be taken off wherever it sits. */
type MarkStore = Map<number, number[]>

function entryForMark(marks: MarkStore, markId: number) {
  for (const [entryId, ids] of marks) {
    if (ids.includes(markId)) {
      return entryId
    }
  }

  return undefined
}

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

/** A partway failure is wound back: the history gains its entry only if this
    resolves; a page keeping its share would hold a mark nothing can take back. */
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
      // One page, one annotation, so there is nothing to wind back; a translucent
      // block is a drawn shape, a blur or mosaic built from the page's own pixels.
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
      // What comes back is where the marks really were — which is what puts
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
      // Only ever a redo here — the first apply reads the pages across below.
      // A redo restores the stash rather than re-reading a source that moved on.
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

/** `false` is a long run the reader stopped, the backend already rolled back —
    so this throws, and the queue commits no history entry for what threw. */
async function runOwnedLayerCommand(
  command: string,
  args: Record<string, unknown>,
) {
  if (!(await invoke<boolean>(command, args))) {
    throw new PdfOperationCancelled()
  }
}

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

/** A mark is taken off by the ids its apply recorded, so an undo finds its own
    annotations wherever the eraser has left them sitting on the page. */
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
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("restore_pdf_pages", {
          documentId,
          stashId: command.stashId,
        }),
      )
      return []
    case "insertBlankPage":
      // Pristine by now — LIFO undo has taken back anything drawn on it — but
      // stashed under this entry's id, which a redo's insert leaves behind.
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
      // Applies the mark's own command again, aimed at the pages its marks were
      // really on; PDFium only appends, so a mark under another comes back over it.
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

/** PDFium's document is the truth about what is on a page, so nothing here
    mirrors the annotations, only what it cannot answer about the reader's steps. */
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
  // Page-moving edits in flight: a grid edit must not plan against positions one
  // is about to change, and a mark made meanwhile would land on the wrong page.
  const structurePendingRef = useRef(0)
  // React state lags until a re-render: an operation starting inside another's
  // round trip would plan against a history a step out of date.
  const historyRef = useRef(emptyHistory)
  // Bumped when the document changes, so work still in flight against the last
  // one lands nowhere rather than on its successor.
  const generationRef = useRef(0)
  // PDFium serializes this work anyway; the queue makes the history move in the
  // same order, so no step plans against a document a queued one will change.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  // The one thing kept about the annotations themselves: which marks each
  // applied entry holds, so an undo and the eraser can name them, not count them.
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

  /** `plan` runs inside the queue, so work and the history left behind are decided
      together; a `work` answering false — a cancelled export — commits nothing. */
  const enqueue = useCallback(
    (
      plan: (
        history: AnnotationHistory,
      ) => {
        pages: number[]
        textPages: number[]
        work: () => Promise<boolean>
        next: AnnotationHistory
        /** For a command whose fields are known only once its work runs — an
            insert learns its count from the backend; `next` is the placeholder. */
        reconcile?: () => AnnotationHistory
        /** Pages only the backend can name — where a mark really was, which a
            structure edit may have renumbered since. Redrawn alongside `pages`. */
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
          // Carried rather than swallowed: a refusal — nothing installed can
          // draw this text — is the reader's to act on, per the error itself.
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

      // A drawing or note carries the page it was made on; a page-moving edit in
      // flight would land it on the wrong page. Dropped rather than misplaced.
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

  /** Every structure edit's one path: planned inside the queue, which hands the
      stash its entry id. Resolves false for a no-op plan and failed work alike. */
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

  /** Cannot go through `commitStructure`: the file's page count is unknown
      until the backend reads it, so `reconcile` writes back what it learned. */
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
            // A position the document does not have — the grid has since been
            // renumbered. A null plan reaches neither path, so it is said here.
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

  /** Like `insertFile` it cannot go through `commitStructure`: the first apply
      reads the pages across, and only a redo restores the undo's stash. */
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
            // A position this document does not have — the grid has since been
            // renumbered. A null plan reaches neither path, so it is said here.
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

  /** Takes `insertPages`' path rather than `commitStructure`'s for the same
      reason: there the apply *is* the redo, restoring the undo's stash. */
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
            // A page or position it no longer has — the grid has since been
            // renumbered. A null plan reaches neither path, so it is said here.
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

  /** Rubs out whichever of this session's marks the backend's hit test finds —
      nothing of the document's own answers, and the history is left alone. */
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

  /** Planned against the history the queue has actually reached; the outcome
      keeps the dialog open on a refusal rather than closing over an error. */
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

  /** The one gesture that reaches a rebuild in flight. `false` is a miss, not a
      failure — the ask came before the command listed itself, and is repeated. */
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

  // Undo and redo count as page-shifting — the entry taken back may be a
  // structure edit, and peeking at it is no better: a pending edit could change it.
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

  /** Queued behind the reader's marks, so the file holds what the history says
      was saved; marked saved only when the write landed on its own file. */
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

  /** Off the ref, not the rendered state: a guard deciding whether marks may be
      discarded must not trust a value that can lag the queue by a render. */
  const isDirtyNow = useCallback(() => isDirty(historyRef.current), [])

  /** Whether a structure edit is in flight this instant — the guard a grid edit
      checks so it never plans against positions one is about to change. */
  const hasPendingWorkNow = useCallback(() => pendingRef.current > 0, [])
  const isStructureBusyNow = useCallback(() => structurePendingRef.current > 0, [])

  /** Off the ref: awaited operations resolve after it moves but before the
      re-render, so a follow-up needing the fresh history has to read it here. */
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
