import type { RefObject } from "react"

import type { DocumentNotices } from "@/hooks/useNotices"
import type { useAnnotations } from "@/hooks/useAnnotations"
import type { usePageClipboard } from "@/hooks/usePageClipboard"
import type { useThumbnailSelection } from "@/hooks/useThumbnailSelection"
import type { PdfDocumentInfo } from "@/lib/pdf"
import {
  pagesToRotate,
  QUARTER_TURN,
} from "@/lib/pageRotation"
import { pastePlan } from "@/lib/pageClipboard"
import type { SelectionModifiers } from "@/lib/thumbnailSelection"
import type { ViewMode } from "@/lib/viewMode"

type UseThumbnailPageOpsOptions = {
  annotations: ReturnType<typeof useAnnotations>
  pageClipboard: ReturnType<typeof usePageClipboard>
  /** The gap a grid-initiated jump owes a seek to, once the page view is back. */
  pendingScrollPageRef: RefObject<number | null>
  pdfDocument: PdfDocumentInfo
  notice: DocumentNotices
  setBookmarksOpen: (open: boolean) => void
  setPreferredViewMode: (mode: ViewMode) => void
  thumbnailSelection: ReturnType<typeof useThumbnailSelection>
}

/**
 * The thumbnail grid's page edits: delete, insert, rotate, reorder, and the
 * clipboard's paste — all through the ordinary annotation commands, so each
 * stays one undo away.
 */
export function useThumbnailPageOps({
  annotations,
  pageClipboard,
  pendingScrollPageRef,
  pdfDocument,
  notice,
  setBookmarksOpen,
  setPreferredViewMode,
  thumbnailSelection,
}: UseThumbnailPageOpsOptions) {
  // Gestures name pages read off the screen, so they are dropped while a
  // page-shifting edit is in flight; an annotation in flight shifts nothing.
  const editingBusy = () => annotations.isStructureBusyNow()

  // Double-clicking a thumbnail leaves the grid for the page itself; a single
  // click is selection now, so navigation moved to the second click.
  const openThumbnailPage = (pageNumber: number) => {
    pendingScrollPageRef.current = pageNumber
    setBookmarksOpen(false)
    setPreferredViewMode("single")
  }

  const selectThumbnailPage = (
    pageNumber: number,
    modifiers: SelectionModifiers,
  ) => {
    thumbnailSelection.select(pageNumber, modifiers)
  }

  // A right-click on a page the selection does not hold takes the selection to
  // it, as every file manager does: the menu then acts on what is on screen.
  const menuThumbnailPage = (pageNumber: number) => {
    if (!thumbnailSelection.selectedPages.has(pageNumber)) {
      thumbnailSelection.select(pageNumber, { range: false, toggle: false })
    }
  }

  // On a selected page the x takes the whole selection with it; on any other
  // page, that page alone. No confirmation: the delete is one undo away.
  const deleteThumbnailPage = (pageNumber: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    const pages = thumbnailSelection.selectedPages.has(pageNumber)
      ? [...thumbnailSelection.selectedPages]
      : [pageNumber]

    void annotations.deletePages(pages, pdfDocument.numPages)
  }

  const insertBlankPage = (index: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    void annotations.insertBlankPage(index, pdfDocument.numPages)
  }

  /**
   * The rotate button over the grid, where turning a page edits the document —
   * undone and saved like any other — taking the selection, or all of it.
   */
  const rotateThumbnailPages = () => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    void annotations.rotatePages(
      pagesToRotate(pdfDocument.numPages, thumbnailSelection.selectedPages),
      QUARTER_TURN,
    )
  }

  /**
   * A cut is a move, one undo step by way of the reorder command; a copy stays
   * on the clipboard, following the pages its own insert pushed down.
   */
  const pastePages = (index: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    const plan = pastePlan(pageClipboard.clipboard, index, pdfDocument.numPages)

    if (!plan) {
      return
    }

    const count = plan.pages.length
    const at = index <= pdfDocument.numPages ? index : undefined

    // Said once the edit has landed rather than when it was asked for: a
    // refusal has its own notice, and two would be one too many.
    if (plan.kind === "move") {
      void annotations.reorderPages(plan.order).then((landed) => {
        if (landed) {
          notice.raise(
            at === undefined ? "pagesMovedToEnd" : "pagesMoved",
            { values: at === undefined ? { count } : { at, count } },
          )
        }
      })

      return
    }

    // Armed before the work, because the insert's own structure change is what
    // reaches the clipboard first — and disarmed if that insert never lands.
    pageClipboard.armPaste(index, count, pdfDocument.numPages)
    void annotations
      .duplicatePages(plan.pages, index, pdfDocument.numPages)
      .then((landed) => {
        if (landed) {
          notice.raise(
            at === undefined ? "pagesPastedToEnd" : "pagesPasted",
            { values: at === undefined ? { count } : { at, count } },
          )
        } else {
          pageClipboard.disarmPaste()
        }
      })
  }

  // Answered with, rather than voided: the grid holds the pages where the drop
  // put them until this settles, since nothing moves before the backend has.
  const reorderPages = (order: number[]) => {
    if (editingBusy()) {
      return
    }

    return annotations.reorderPages(order)
  }

  return {
    deleteThumbnailPage,
    insertBlankPage,
    menuThumbnailPage,
    openThumbnailPage,
    pastePages,
    reorderPages,
    rotateThumbnailPages,
    selectThumbnailPage,
  }
}
