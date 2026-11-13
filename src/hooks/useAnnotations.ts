import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Channel, invoke } from "@tauri-apps/api/core"

import {
  canRedo,
  canUndo,
  commandPageChange,
  commandPages,
  commandTextPages,
  commit,
  droppedStashIds,
  emptyHistory,
  fillErasedPages,
  insertPagesRange,
  movesPages,
  nextRedoCommand,
  nextUndoCommand,
  pageNumbersConfig as currentPageNumbersConfig,
  planDeletePages,
  planDuplicatePages,
  planInsertPages,
  planEraseAnnotation,
  planInsertBlankPage,
  planFileOptions,
  planInsertFiles,
  planRenameSection,
  planPageNumbersChange,
  planReorderPages,
  planRotatePages,
  planWatermarkChange,
  redo,
  retargetCommand,
  undo,
  watermarkConfig as currentWatermarkConfig,
  type AnnotationCommand,
  type AnnotationEntry,
  type AnnotationHistory,
  type HighlightCommand,
  type PageChange,
  type ReorderPagesCommand,
  type RenderEpochs,
} from "@/lib/annotations"
import type { PagePoint } from "@/lib/annotationGeometry"
import { isDirty, markSaved } from "@/lib/documentState"
import { e2eOverride } from "@/lib/e2e"
import { isSourceChanged } from "@/lib/fileSources"
import type { ArchiveExportRequest } from "@/lib/archiveExport"
import type { CompressedExportRequest } from "@/lib/compressExport"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import type {
  A4Saved,
  FileOptions,
  PdfExportOutcome,
  PdfStructureUpdate,
  SignatureDecision,
} from "@/lib/pdf"
import {
  PdfOperationCancelled,
  type PdfLayerOutcome,
  type PdfOwnedLayer,
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

type StructureChangeHandler = (
  documentId: number,
  update: PdfStructureUpdate,
  change?: PageChange,
) => void

/** A change to the document itself, or a new file made of its pages. */
export type SignedChange = "edit" | "export"

type UseAnnotationsOptions = {
  /** The reader's word on intact signatures, before a change that breaks
      them; `true` where none is owed, without a turn of the event loop. */
  beforeSignedChange?: (change: SignedChange) => true | Promise<boolean>
  /** The same word from another open document whose pages are copied in. */
  beforeCopyFrom?: (sourceDocumentId: number) => true | Promise<boolean>
  documentId: number
  /** A moved tab's history and marks, replayed as this session's own: undo,
      the dirty flag, and the export-only refusals keep answering as they did
      in the window the tab came from. Read once, at the first mount. */
  initial?: { history: AnnotationHistory; marks: [entryId: number, markIds: number[]][] }
  /** `command` is the edit that failed, where re-running it is the recovery —
      a note otherwise lost with the editor that held it. Absent for a refusal. */
  onAnnotateError: (error?: unknown, command?: AnnotationCommand) => void
  /** A mark refused because a page-shifting edit is still in flight: it was
      drawn against pages that edit is about to move. */
  onEditRefused?: () => void
  onExportError: (error: unknown) => void
  onExported: (documentId: number, outcome: PdfExportOutcome) => void
  /** A watermark or page-number undo or redo rebuilding the pages it covers;
      `null` once it is over, however it ended. */
  onLayerProgress?: (layer: PdfOwnedLayer, progress: PdfProgress | null) => void
  onSaveError: () => void
  /** Stashes the history can no longer restore, already being discarded. */
  onStashesDropped?: (stashIds: number[]) => void
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
          sections: command.sections?.after,
        }),
        commandPageChange(command, false),
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
        commandPageChange(command, false),
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
        commandPageChange(command, false),
      )
      return []
    case "insertBlankPage":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("insert_pdf_blank_page", {
          documentId,
          index: command.index,
          section: command.section,
        }),
        commandPageChange(command, false),
      )
      return []
    case "duplicatePages":
    case "insertPages":
    case "insertFiles":
      // Only ever a redo here — the first apply copies the pages below. A redo
      // restores the stash rather than copying again.
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("restore_pdf_pages", {
          documentId,
          stashId: command.stashId,
        }),
        commandPageChange(command, false),
      )
      return []
    case "renameSection":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("rename_pdf_section", {
          documentId,
          sectionId: command.sectionId,
          title: command.title,
        }),
        commandPageChange(command, false),
      )
      return []
    case "fileOptions":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("set_pdf_file_options", {
          documentId,
          options: command.next,
        }),
        commandPageChange(command, false),
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
  onProgress?: ProgressHandler,
): Promise<number[]> {
  switch (command.kind) {
    case "watermark":
      if (command.previous) {
        await runOwnedLayerCommand("apply_pdf_watermark", {
          config: command.previous,
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
      if (command.previous) {
        await runOwnedLayerCommand("apply_pdf_page_numbers", {
          config: command.previous,
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
          order: command.inverse,
          sections: command.sections?.before,
        }),
        commandPageChange(command, true),
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
        commandPageChange(command, true),
      )
      return []
    case "deletePages":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("restore_pdf_pages", {
          documentId,
          stashId: command.stashId,
        }),
        commandPageChange(command, true),
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
        commandPageChange(command, true),
      )
      return []
    case "duplicatePages":
    case "insertPages":
    case "insertFiles":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("delete_pdf_pages", {
          documentId,
          pageNumbers: insertPagesRange(command),
          stashId: command.stashId,
        }),
        commandPageChange(command, true),
      )
      return []
    case "renameSection":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("rename_pdf_section", {
          documentId,
          sectionId: command.sectionId,
          title: command.previous,
        }),
        commandPageChange(command, true),
      )
      return []
    case "fileOptions":
      onStructureChange(
        documentId,
        await invoke<PdfStructureUpdate>("set_pdf_file_options", {
          documentId,
          options: command.previous,
        }),
        commandPageChange(command, true),
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
  beforeCopyFrom,
  beforeSignedChange,
  documentId,
  initial,
  onAnnotateError,
  onEditRefused,
  onExportError,
  onExported,
  onLayerProgress,
  onSaveError,
  onStashesDropped,
  onStructureChange,
  onSuccess,
}: UseAnnotationsOptions) {
  const [history, setHistory] = useState<AnnotationHistory>(
    () => initial?.history ?? emptyHistory,
  )
  const [renderEpochs, setRenderEpochs] = useState<RenderEpochs>({})
  // Commit receipts need the queue's exact epoch, before React renders it.
  const renderEpochsRef = useRef<RenderEpochs>({})
  const [textEpochs, setTextEpochs] = useState<RenderEpochs>({})
  const [pending, setPending] = useState(0)
  // The synchronous counterpart to `pending`: guards cannot wait for React to
  // render before deciding whether a tab may be discarded.
  const pendingRef = useRef(0)
  // Page-moving edits in flight: a page edit must not plan against positions one
  // is about to change, and a mark made meanwhile would land on the wrong page.
  const structurePendingRef = useRef(0)
  // React state lags until a re-render: an operation starting inside another's
  // round trip would plan against a history a step out of date.
  const historyRef = useRef<AnnotationHistory>(initial?.history ?? emptyHistory)
  // Bumped when the document changes, so work still in flight against the last
  // one lands nowhere rather than on its successor.
  const generationRef = useRef(0)
  // PDFium serializes this work anyway; the queue makes the history move in the
  // same order, so no step plans against a document a queued one will change.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  // The one thing kept about the annotations themselves: which marks each
  // applied entry holds, so an undo and the eraser can name them, not count them.
  const marksRef = useRef<MarkStore>(new Map(initial?.marks ?? []))
  const beforeSignedChangeRef = useRef(beforeSignedChange)
  const beforeCopyFromRef = useRef(beforeCopyFrom)

  useLayoutEffect(() => {
    beforeSignedChangeRef.current = beforeSignedChange
    beforeCopyFromRef.current = beforeCopyFrom
  }, [beforeCopyFrom, beforeSignedChange])

  // Awaited by callers only where an answer is owed: elsewhere an edit still
  // enqueues in the same turn, as the drops that need an idle queue rely on.
  const signedChangeReady = useCallback(
    (change: SignedChange) => beforeSignedChangeRef.current?.(change) ?? true,
    [],
  )

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
            const stranded = droppedStashIds(historyRef.current, committed)
            historyRef.current = committed
            setHistory(committed)

            // Unqueued: no later step can name a stash its history dropped.
            if (stranded.length > 0) {
              void invoke("discard_pdf_stashes", {
                documentId,
                stashIds: stranded,
              }).catch(() => undefined)
              onStashesDropped?.(stranded)
            }
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
    [applyEpochs, documentId, onStashesDropped, onSuccess],
  )

  const commitCommand = useCallback(
    async (
      command: AnnotationCommand,
      onApplied?: (epochs: RenderEpochs) => void,
      prepare?: () => Promise<boolean>,
    ) => {
      // A drawing or note carries the page it was made on; a page-moving edit in
      // flight would land it on the wrong page. Refused rather than misplaced,
      // and said so: the reader's stroke is gone.
      if (structurePendingRef.current > 0) {
        onEditRefused?.()
        return false
      }

      const ready = signedChangeReady("edit")

      if (ready !== true) {
        if (!(await ready)) {
          return false
        }

        // A flatten answered earlier runs here with no modal prompt, so a
        // page-moving edit may have started meanwhile.
        if (structurePendingRef.current > 0) {
          onEditRefused?.()
          return false
        }
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
            // Font preparation belongs to the edit's queue slot too: save,
            // undo and page moves must not overtake a note already submitted.
            if (prepare && !(await prepare())) return false
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
    [
      documentId,
      enqueue,
      onAnnotateError,
      onEditRefused,
      onStructureChange,
      signedChangeReady,
    ],
  )

  /** Every structure edit's one path: planned inside the queue, which hands the
      stash its entry id. Resolves false for a no-op plan and failed work alike.
      With `after`, the edit holds its place in the queue until that answers,
      and is made only if it answers true. */
  const commitStructure = useCallback(
    async (
      plan: (
        history: AnnotationHistory,
      ) => { command: AnnotationCommand; history: AnnotationHistory } | null,
      after?: Promise<boolean>,
    ): Promise<boolean> => {
      let landed = false

      // Counted from the ask, not the enqueue: an edit waiting on a flatten
      // still names the pages as they stand, and one asked for meanwhile would
      // queue behind it with numbers it is about to move.
      structurePendingRef.current += 1

      try {
        const ready = signedChangeReady("edit")

        if (ready !== true && !(await ready)) {
          return false
        }

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
              if (after && !(await after)) {
                return false
              }

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
    [documentId, enqueue, onAnnotateError, onStructureChange, signedChangeReady],
  )

  const reorderPages = useCallback(
    (order: number[], sections?: ReorderPagesCommand["sections"]) =>
      commitStructure((current) => planReorderPages(current, order, sections)),
    [commitStructure],
  )

  const rotatePages = useCallback(
    (pages: number[], degrees: number) =>
      commitStructure((current) => planRotatePages(current, pages, degrees)),
    [commitStructure],
  )

  /** With `after`, the pages a cut takes into another document: they go once
      its copies have landed there. */
  const deletePages = useCallback(
    (pages: number[], pageCount: number, after?: Promise<boolean>) =>
      commitStructure((current) => planDeletePages(current, pages, pageCount), after),
    [commitStructure],
  )

  const insertBlankPage = useCallback(
    (index: number, pageCount: number, section?: number) =>
      commitStructure((current) => planInsertBlankPage(current, index, pageCount, section)),
    [commitStructure],
  )

  /** Not through `commitStructure`: the first apply copies the pages, and a
      redo is what restores the undo's stash. */
  const duplicatePages = useCallback(
    async (sourcePages: number[], index: number, pageCount: number, section?: number) => {
      let landed = false

      // From the ask, as `commitStructure` counts.
      structurePendingRef.current += 1

      try {
        const ready = signedChangeReady("edit")

        if (ready !== true && !(await ready)) {
          return false
        }

        await enqueue((current) => {
          const planned = planDuplicatePages(
            current,
            sourcePages,
            index,
            pageCount,
            section,
          )

          if (!planned) {
            // A page or position it no longer has — the pages have since been
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
                  section,
                }),
                commandPageChange(planned.command, false),
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
    [documentId, enqueue, onAnnotateError, onStructureChange, signedChangeReady],
  )

  /**
   * `duplicatePages`' path, with the pages read from another open document by
   * their numbers there: `stands` says whether those still name them, asked
   * once the source's prompt is answered, before this document's flatten, and
   * again as the copy is made; `"moved"` is the answer where they no longer do.
   * `taking` hears of the copy as it starts, for a cut to leave its own
   * document then, ahead of any later edit there.
   */
  const insertPages = useCallback(
    async (
      sourceDocumentId: number,
      sourcePages: number[],
      index: number,
      pageCount: number,
      section: number | undefined,
      from: { stands: () => boolean; taking?: (copied: Promise<boolean>) => void },
    ): Promise<boolean | "moved"> => {
      let landed = false
      let moved = false

      // From the ask, as `commitStructure` counts.
      structurePendingRef.current += 1

      try {
        // The source first: its answer changes nothing in place, while this
        // document's flatten does, and must not happen for a copy then refused.
        const source = beforeCopyFromRef.current?.(sourceDocumentId) ?? true

        if (source !== true && !(await source)) {
          return false
        }

        if (!from.stands()) {
          return "moved"
        }

        const ready = signedChangeReady("edit")

        if (ready !== true && !(await ready)) {
          return false
        }

        await enqueue((current) => {
          const planned = planInsertPages(
            current,
            sourceDocumentId,
            sourcePages,
            index,
            pageCount,
            section,
          )

          if (!planned) {
            onAnnotateError()
            return null
          }

          return {
            next: planned.history,
            pages: commandPages(planned.command),
            textPages: commandTextPages(planned.command),
            work: async () => {
              // In the same turn as the read is asked for: nothing there can
              // move the pages between this answer and the copy.
              if (!from.stands()) {
                moved = true
                return false
              }

              let copied: (landed: boolean) => void = () => {}

              // Settled however this ends: the source's delete holds its queue
              // until it is.
              try {
                from.taking?.(
                  new Promise<boolean>((resolve) => {
                    copied = resolve
                  }),
                )
                onStructureChange(
                  documentId,
                  await invoke<PdfStructureUpdate>(
                    "insert_pdf_pages_from_document",
                    {
                      documentId,
                      index,
                      pageNumbers: planned.command.sourcePages,
                      section,
                      sourceDocumentId,
                    },
                  ),
                  commandPageChange(planned.command, false),
                )
              } catch (error) {
                copied(false)
                throw error
              }

              copied(true)
              landed = true
              return true
            },
          }
        }, onAnnotateError)
      } finally {
        structurePendingRef.current -= 1
      }

      return moved ? "moved" : landed
    },
    [documentId, enqueue, onAnnotateError, onStructureChange, signedChangeReady],
  )

  /** `insertPages`' path for files read from disk: `sources` are what
      `read_pdf_sources` read, each a file of its own once added, and one
      undo takes them all out again. */
  const insertFiles = useCallback(
    async (
      sources: { id: number; pages: number; title: string }[],
      index: number,
      pageCount: number,
      files: {
        options: FileOptions
        ownTitle: string
        /** By source id, for each signed source. */
        signatures: Record<number, SignatureDecision>
      },
    ): Promise<boolean | "changed"> => {
      let landed: boolean | "changed" = false

      // From the ask, as `commitStructure` counts.
      structurePendingRef.current += 1

      try {
        const ready = signedChangeReady("edit")

        if (ready !== true && !(await ready)) {
          return false
        }

        await enqueue((current) => {
          const planned = planInsertFiles(
            current,
            sources.map((source) => source.title),
            sources.reduce((total, source) => total + source.pages, 0),
            index,
            pageCount,
          )

          if (!planned) {
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
                await invoke<PdfStructureUpdate>("insert_pdf_files", {
                  documentId,
                  index,
                  options: files.options,
                  ownTitle: files.ownTitle,
                  signatures: files.signatures,
                  sourceIds: sources.map((source) => source.id),
                }),
                commandPageChange(planned.command, false),
              )
              landed = true
              return true
            },
          }
        }, (error) => {
          // Said apart: the reader can add the file again as it now stands.
          if (isSourceChanged(error)) {
            landed = "changed"
          } else {
            onAnnotateError()
          }
        })
      } finally {
        structurePendingRef.current -= 1
      }

      // Set by the queue, which narrowing cannot see.
      return landed as boolean | "changed"
    },
    [documentId, enqueue, onAnnotateError, onStructureChange, signedChangeReady],
  )

  /** Names no page's content, so no signature is asked about; a Save As
      writes the name as the file's bookmark. A file options change, too. */
  const commitFileChange = useCallback(
    async (
      plan: (
        current: AnnotationHistory,
      ) => { command: AnnotationCommand; history: AnnotationHistory } | null,
    ) => {
      let landed = false

      await enqueue((current) => {
        const planned = plan(current)

        if (!planned) {
          return null
        }

        return {
          next: planned.history,
          pages: [],
          textPages: [],
          work: async () => {
            await applyCommand(
              documentId,
              current.nextId,
              planned.command,
              onStructureChange,
              marksRef.current,
            )
            landed = true
            return true
          },
        }
      }, onAnnotateError)

      return landed
    },
    [documentId, enqueue, onAnnotateError, onStructureChange],
  )

  const renameSection = useCallback(
    (sectionId: number, title: string, previous: string) =>
      commitFileChange((current) => planRenameSection(current, sectionId, title, previous)),
    [commitFileChange],
  )

  /** `current` is read when the change takes its turn, so a toggle made while
      another is in flight builds on that one rather than undoing it. */
  const setFileOptions = useCallback(
    (change: Partial<FileOptions>, current: () => FileOptions | undefined) =>
      commitFileChange((history) => {
        const previous = current()

        return previous ? planFileOptions(history, { ...previous, ...change }, previous) : null
      }),
    [commitFileChange],
  )

  /** Draws the document's signatures into its pages in place, ahead of the
      edit that asked for it: no history entry, since the file it came from is
      never written over and nothing of this session's own is there to undo. */
  const flattenSignatures = useCallback(
    async (pageCount: number) => {
      const pages = Array.from({ length: pageCount }, (_, index) => index + 1)
      let flattened = false

      await enqueue(
        (current) => ({
          next: current,
          pages,
          textPages: pages,
          work: async () => {
            onStructureChange(
              documentId,
              await invoke<PdfStructureUpdate>("flatten_pdf_signatures", { documentId }),
              { movement: "inPlace" },
            )
            flattened = true
            return true
          },
        }),
        // The session says why: the answer is the reader's to give again.
        () => undefined,
      )

      return flattened
    },
    [documentId, enqueue, onStructureChange],
  )

  /** Rubs out whichever of this session's marks the backend's hit test finds —
      nothing of the document's own answers, and the history is left alone. */
  const eraseAt = useCallback(
    async (pageNumber: number, point: PagePoint) => {
      // The same guard a drawing takes: a page-moving edit in flight is about
      // to renumber the page this hit test would name.
      if (structurePendingRef.current > 0) {
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
      const ready = signedChangeReady("edit")

      if (ready !== true && !(await ready)) {
        return "cancelled"
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
    [documentId, enqueue, onAnnotateError, onStructureChange, signedChangeReady],
  )

  const setPageNumbers = useCallback(
    async (
      config: PageNumbersConfig | null,
      pageCount: number,
      onProgress?: ProgressHandler,
    ): Promise<PdfLayerOutcome> => {
      const ready = signedChangeReady("edit")

      if (ready !== true && !(await ready)) {
        return "cancelled"
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
    [documentId, enqueue, onAnnotateError, onStructureChange, signedChangeReady],
  )

  /** The one gesture that reaches a rebuild in flight. `false` is a miss, not a
      failure — the ask came before the command listed itself, and is repeated. */
  const cancelOperation = useCallback(async () => {
    try {
      return await invoke<boolean>("cancel_pdf_operation", { documentId })
    } catch {
      // Nothing to report: the work either stops or finishes, and both are
      // already answered by the operation's own result.
      return false
    }
  }, [documentId])

  /** An undo or redo holds marks back only where its step may shift pages.
      With the queue idle, the step it will take is the one in view now; with
      work queued ahead, that work may change it, so it counts regardless. A
      layer's undo leaves every page where it is — and may run for minutes. */
  const mayShiftPages = useCallback(
    (entry: AnnotationEntry | undefined) =>
      pendingRef.current > 0 ||
      (entry !== undefined &&
        (movesPages(entry.command) || entry.command.kind === "rotatePages")),
    [],
  )

  /** A layer step reports its rebuild and can be stopped; the stop is the
      reader's own, so it is not reported back as a failure. */
  const runHistoryStep = useCallback(
    async (
      step: (
        current: AnnotationHistory,
      ) => { entry: AnnotationEntry; history: AnnotationHistory } | null,
      work: (
        entry: AnnotationEntry,
        onProgress: ProgressHandler | undefined,
      ) => Promise<number[]>,
      shifting: boolean,
    ) => {
      if (shifting) {
        structurePendingRef.current += 1
      }

      try {
        await enqueue((current) => {
          const taken = step(current)

          if (!taken) {
            return null
          }

          const { command } = taken.entry
          const layer =
            command.kind === "watermark" || command.kind === "pageNumbers"
              ? command.kind
              : null
          let reported: number[] = []

          return {
            next: taken.history,
            pages: commandPages(command),
            textPages: commandTextPages(command),
            touched: () => reported,
            work: async () => {
              // A channel's messages can trail its command's answer; one landing
              // after the end would put back a standing notice nothing retracts.
              let over = false

              try {
                reported = await work(
                  taken.entry,
                  layer
                    ? (progress) => {
                        if (!over) {
                          onLayerProgress?.(layer, progress)
                        }
                      }
                    : undefined,
                )
              } finally {
                over = true

                if (layer) {
                  onLayerProgress?.(layer, null)
                }
              }

              return true
            },
          }
        }, (error) => {
          if (!(error instanceof PdfOperationCancelled)) {
            onAnnotateError(error)
          }
        })
      } finally {
        if (shifting) {
          structurePendingRef.current -= 1
        }
      }
    },
    [enqueue, onAnnotateError, onLayerProgress],
  )

  const undoCommand = useCallback(async () => {
    await runHistoryStep(
      undo,
      (entry, onProgress) =>
        retractCommand(
          documentId,
          entry.id,
          entry.command,
          onStructureChange,
          marksRef.current,
          onProgress,
        ),
      mayShiftPages(historyRef.current.past.at(-1)),
    )
  }, [documentId, mayShiftPages, onStructureChange, runHistoryStep])

  const redoCommand = useCallback(async () => {
    await runHistoryStep(
      redo,
      (entry, onProgress) =>
        applyCommand(
          documentId,
          entry.id,
          entry.command,
          onStructureChange,
          marksRef.current,
          onProgress,
        ),
      mayShiftPages(historyRef.current.future.at(-1)),
    )
  }, [documentId, mayShiftPages, onStructureChange, runHistoryStep])

  /** Queued behind the reader's marks, so the file holds what the history says
      was saved; marked saved only when the document is now bound to that file. */
  const exportCopy = useCallback(
    async (suggestedName: string, filterLabel: string) => {
      let result: "saved" | "cancelled" | "failed" = "cancelled"

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

            result = "saved"
            onExported(documentId, outcome)
            return outcome.savedToSource
          },
        }),
        (error) => {
          result = "failed"
          onExportError(error)
        },
      )

      return result as "saved" | "cancelled" | "failed"
    },
    [documentId, enqueue, onExported, onExportError],
  )

  const exportArchive = useCallback(
    async (request: ArchiveExportRequest, onProgress: ProgressHandler) => {
      // Images are pixels; a split PDF carries its pages' signature widgets.
      const ready =
        request.options.format === "images" ? true : signedChangeReady("export")

      if (ready !== true && !(await ready)) {
        return "cancelled"
      }

      let outcome: "saved" | "cancelled" | "failed" = "cancelled"
      await enqueue((current) => ({
        next: current,
        pages: [],
        textPages: [],
        work: async () => {
          const args = { ...request, documentId }
          const override = e2eOverride("exportPdfArchive")
          const path = override
            ? await override(args, onProgress)
            : await invoke<string | null>("export_pdf_archive", {
                ...args,
                onProgress: progressChannel(onProgress),
              })
          outcome = path ? "saved" : "cancelled"
          return false
        },
      }), () => { outcome = "failed" })
      return outcome as "saved" | "cancelled" | "failed"
    },
    [documentId, enqueue, signedChangeReady],
  )

  /** A compressed copy never touches this tab's history: like the archive
      export, it leaves for a destination the backend's own dialog picked. */
  const exportCompressed = useCallback(
    async (request: CompressedExportRequest, onProgress: ProgressHandler) => {
      const ready = signedChangeReady("export")

      if (ready !== true && !(await ready)) {
        return "cancelled"
      }

      let outcome: "saved" | "cancelled" | "failed" = "cancelled"
      await enqueue((current) => ({
        next: current,
        pages: [],
        textPages: [],
        work: async () => {
          const args = { ...request, documentId }
          const override = e2eOverride("exportCompressedPdf")
          const path = override
            ? await override(args, onProgress)
            : await invoke<string | null>("export_compressed_pdf", {
                ...args,
                onProgress: progressChannel(onProgress),
              })
          outcome = path ? "saved" : "cancelled"
          return false
        },
      }), () => { outcome = "failed" })
      return outcome as "saved" | "cancelled" | "failed"
    },
    [documentId, enqueue, signedChangeReady],
  )

  /** Queued behind the reader's edits, so the A4 copy holds what the pages
      show. The copy is a document of its own, bound to the file it was
      written to; null for a dialog cancelled or a run stopped. */
  const exportA4 = useCallback(
    async (
      request: { filterLabel: string; suggestedName: string },
      onProgress: ProgressHandler,
    ): Promise<A4Saved | null | { failed: unknown }> => {
      const ready = signedChangeReady("export")

      if (ready !== true && !(await ready)) {
        return null
      }

      let written: A4Saved | null = null
      let failed: { failed: unknown } | null = null

      await enqueue(
        (current) => ({
          next: current,
          pages: [],
          textPages: [],
          work: async () => {
            const args = { ...request, documentId, onProgress: progressChannel(onProgress) }
            const override = e2eOverride("saveA4Pdf")

            written = override
              ? await override(args)
              : await invoke<A4Saved | null>("save_a4_pdf", args)
            return false
          },
        }),
        (error) => {
          failed = { failed: error }
        },
      )

      return failed ?? written
    },
    [documentId, enqueue, signedChangeReady],
  )

  /** Writes the document back over its own file. A clean history is a no-op —
      judged inside the queue, against the history it has actually reached. */
  const save = useCallback(async () => {
    let saved = true

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
      () => {
        saved = false
        onSaveError()
      },
    )

    return saved
  }, [documentId, enqueue, onSaveError])

  /** The watermark or page numbers the queue's history holds this instant,
      which leave the document export-only. */
  const hasOwnedContentNow = useCallback(
    () =>
      currentWatermarkConfig(historyRef.current) !== null ||
      currentPageNumbersConfig(historyRef.current) !== null,
    [],
  )

  /** Resolves once everything queued so far has run: a close deciding what is
      left to save must not decide against work still on its way. */
  const settled = useCallback(
    () => queueRef.current.then(
      () => undefined,
      () => undefined,
    ),
    [],
  )

  /** Off the ref, not the rendered state: a guard deciding whether marks may be
      discarded must not trust a value that can lag the queue by a render. */
  const isDirtyNow = useCallback(() => isDirty(historyRef.current), [])

  /** Whether a structure edit is in flight this instant — the guard a page edit
      checks so it never plans against positions one is about to change. */
  const hasPendingWorkNow = useCallback(() => pendingRef.current > 0, [])
  const isStructureBusyNow = useCallback(() => structurePendingRef.current > 0, [])

  /** Off the ref: awaited operations resolve after it moves but before the
      re-render, so a follow-up needing the fresh history has to read it here. */
  const historyNow = useCallback(() => historyRef.current, [])

  /** What a tab move carries, or nothing while work is in flight: a command
      settling after the snapshot would change a document its history no longer
      describes — a watermarked save guard is not a place to find that out. */
  const snapshotForMove = useCallback(() => {
    if (pendingRef.current > 0) {
      return null
    }

    return {
      history: historyRef.current,
      marks: [...marksRef.current.entries()],
    }
  }, [])

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
      exportA4,
      exportCopy,
      exportArchive,
      exportCompressed,
      flattenSignatures,
      hasOwnedContentNow,
      hasPendingWorkNow,
      historyNow,
      insertBlankPage,
      insertFiles,
      insertPages,
      /** An edit is queued or under way; a new one would wait behind it. */
      isBusy,
      isDirty: isDirty(history),
      isDirtyNow,
      isStructureBusyNow,
      nextRedo: nextRedoCommand(history),
      nextUndo: nextUndoCommand(history),
      pageNumbersConfig: currentPageNumbersConfig(history),
      redo: redoCommand,
      renameSection,
      reorderPages,
      renderEpochs,
      reset,
      rotatePages,
      save,
      setFileOptions,
      setPageNumbers,
      setWatermark,
      settled,
      snapshotForMove,
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
      exportA4,
      exportCopy,
      exportArchive,
      exportCompressed,
      flattenSignatures,
      hasOwnedContentNow,
      hasPendingWorkNow,
      history,
      historyNow,
      insertBlankPage,
      insertFiles,
      insertPages,
      isBusy,
      isDirtyNow,
      isStructureBusyNow,
      redoCommand,
      renameSection,
      renderEpochs,
      reorderPages,
      reset,
      rotatePages,
      save,
      setFileOptions,
      setPageNumbers,
      setWatermark,
      settled,
      snapshotForMove,
      textEpochs,
      undoCommand,
    ],
  )
}
