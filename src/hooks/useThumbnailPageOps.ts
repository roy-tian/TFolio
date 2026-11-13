import type { DocumentNotices, NoticeChannel } from "@/hooks/useNotices"
import type { useAnnotations } from "@/hooks/useAnnotations"
import type { usePageClipboard } from "@/hooks/usePageClipboard"
import type { useThumbnailSelection } from "@/hooks/useThumbnailSelection"
import type { CarriedPages } from "@/lib/pageCarry"
import type { PdfDocumentInfo } from "@/lib/pdf"
import { pagesToRotate } from "@/lib/pageRotation"
import { workspaceOwner } from "@/lib/notices"
import { heldPages, movePagesOut, pageSourceOf, pagesStanding, pastePlan } from "@/lib/pageClipboard"
import { emptiesItsFile, reorderSections, sectionAt } from "@/lib/pageSections"

type UseThumbnailPageOpsOptions = {
  annotations: ReturnType<typeof useAnnotations>
  /** Pages a paste has just put in the document, by their numbers now: the
      owner chooses them and brings them into view. */
  onPagesLanded: (pages: number[]) => void
  pageClipboard: ReturnType<typeof usePageClipboard>
  pdfDocument: PdfDocumentInfo
  notice: DocumentNotices
  /** The window's corner, for a refusal about another document: the tab
      taking the pages may not be the one on show. */
  notices: NoticeChannel
  thumbnailSelection: ReturnType<typeof useThumbnailSelection>
}

/**
 * The sidebar previews' page edits: delete, insert, rotate, reorder, and the
 * clipboard's paste — all through the ordinary annotation commands, so each
 * stays one undo away.
 */
export function useThumbnailPageOps({
  annotations,
  onPagesLanded,
  pageClipboard,
  pdfDocument,
  notice,
  notices,
  thumbnailSelection,
}: UseThumbnailPageOpsOptions) {
  // Gestures name pages read off the screen, so they are dropped while a
  // page-shifting edit is in flight; an annotation in flight shifts nothing.
  const editingBusy = () => annotations.isStructureBusyNow()

  // A right-click on a page the selection does not hold takes the selection to
  // it, as every file manager does: the menu then acts on what is on screen.
  const menuThumbnailPage = (pageNumber: number) => {
    if (!thumbnailSelection.selectedPages.has(pageNumber)) {
      thumbnailSelection.select(pageNumber, { range: false, toggle: false })
    }
  }

  // On a chosen page a delete takes the whole choice with it; on any other
  // page, or asked for `alone` from the page's own bar or the reading view,
  // that page only. No confirmation: the delete is one undo away.
  const deleteThumbnailPage = (pageNumber: number, alone = false) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    const pages =
      !alone && thumbnailSelection.selectedPages.has(pageNumber)
        ? [...thumbnailSelection.selectedPages]
        : [pageNumber]

    void annotations.deletePages(pages, pdfDocument.numPages)
  }

  /** That page alone, whatever is chosen: a page's own bar or the reading
      view's menu. */
  const rotateOnePage = (pageNumber: number, degrees: 90 | 270) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    void annotations.rotatePages([pageNumber], degrees)
  }

  /** `section` is the file the page joins, in a document of several: the
      page it was asked for beside. Else the page it goes in front of. */
  const insertBlankPage = (index: number, section?: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    void annotations.insertBlankPage(
      index,
      pdfDocument.numPages,
      section ?? sectionAt(pdfDocument.pages, index),
    )
  }

  /**
   * Rotate in a preview's menu, where turning a page edits the document —
   * undone and saved like any other — taking the selection, or all of it.
   */
  const rotateThumbnailPages = (degrees: 90 | 270) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    void annotations.rotatePages(
      pagesToRotate(pdfDocument.numPages, thumbnailSelection.selectedPages),
      degrees,
    )
  }

  /** Only an idle queue: a copy waiting behind other work would read the
      source's pages by numbers the reader may have changed meanwhile. */
  const canTakeCarriedPages = () => !editingBusy() && !annotations.hasPendingWorkNow()

  // Pages read by number off another document, whose pages moved, or were
  // about to, before the copy could be made.
  const sourceBusy = (sourceDocumentId: number) => {
    const name = pageSourceOf({ sourceDocumentId })?.name()

    if (name) {
      notices.raise({ kind: "pagesAppendBusy", owner: workspaceOwner, values: { name } })
    }
  }

  /**
   * A cut is a move, one undo step by way of the reorder command; a copy stays
   * on the clipboard, following the pages its own insert pushed down. Pages
   * another of the window's documents holds come in as copies, as a drag from
   * its tab brings them, and a cut then leaves the document it was made in.
   */
  const pastePages = (index: number, section?: number) => {
    if (!pdfDocument || editingBusy()) {
      return
    }

    const joins = section ?? sectionAt(pdfDocument.pages, index)
    const { foreign } = pageClipboard

    if (foreign) {
      if (!canTakeCarriedPages() || index < 1 || index > pdfDocument.numPages + 1) {
        return
      }

      // The copy reads its pages by their numbers there, as a drag's release
      // checks of the column it left; a cut also takes them out, so it holds
      // only while it is still the window's to paste.
      const standing = pagesStanding(foreign.sourceDocumentId)
      const stands = () => standing() && (foreign.mode === "copy" || heldPages() === foreign)

      if (!stands()) {
        sourceBusy(foreign.sourceDocumentId)
        return
      }

      const count = foreign.pages.length
      const at = index <= pdfDocument.numPages ? index : undefined
      let kept = false

      void annotations
        .insertPages(foreign.sourceDocumentId, foreign.pages, index, pdfDocument.numPages, joins, {
          stands,
          taking:
            foreign.mode === "cut"
              ? (copied) => {
                  kept = !movePagesOut(foreign, copied)
                }
              : undefined,
        })
        .then((landed) => {
          if (landed === "moved") {
            sourceBusy(foreign.sourceDocumentId)
          }

          if (landed !== true) {
            return
          }

          // A cut of every page its document has leaves them there as well.
          const name = kept ? pageSourceOf(foreign)?.name() : undefined

          if (name) {
            notice.raise("pagesCutKept", { values: { name } })
          } else {
            notice.raise(at === undefined ? "pagesPastedToEnd" : "pagesPasted", {
              values: at === undefined ? { count } : { at, count },
            })
          }

          onPagesLanded(Array.from({ length: count }, (_, offset) => index + offset))
        })

      return
    }

    const clipboard = pageClipboard.clipboard
    const pages = pdfDocument.pages
    // A cut let go where it stands, but among another file's pages, moves no
    // page and joins that file, as a drag let go there does — unless that
    // would leave its own file with no page.
    const plan =
      pastePlan(clipboard, index, pdfDocument.numPages) ??
      (clipboard?.mode === "cut" &&
      joins !== undefined &&
      index >= 1 &&
      index <= pdfDocument.numPages + 1 &&
      clipboard.pages.every((pageNumber) => pageNumber <= pdfDocument.numPages) &&
      clipboard.pages.some((pageNumber) => pages[pageNumber - 1]?.section !== joins) &&
      !emptiesItsFile(pages, clipboard.pages)
        ? { kind: "move" as const, order: pages.map((_, at) => at + 1), pages: clipboard.pages }
        : null)

    if (!plan) {
      return
    }

    const count = plan.pages.length
    const at = index <= pdfDocument.numPages ? index : undefined

    // Said once the edit has landed rather than when it was asked for: a
    // refusal has its own notice, and two would be one too many.
    if (plan.kind === "move") {
      void annotations
        .reorderPages(
          plan.order,
          reorderSections(pdfDocument.pages, plan.order, new Set(plan.pages), joins),
        )
        .then((landed) => {
          if (landed) {
            const moved = new Set(plan.pages)

            notice.raise(
              at === undefined ? "pagesMovedToEnd" : "pagesMoved",
              { values: at === undefined ? { count } : { at, count } },
            )
            onPagesLanded(
              plan.order.flatMap((pageNumber, place) => (moved.has(pageNumber) ? [place + 1] : [])),
            )
          }
        })

      return
    }

    // Armed before the work, because the insert's own structure change is what
    // reaches the clipboard first — and disarmed if that insert never lands.
    pageClipboard.armPaste(index, count, pdfDocument.numPages)
    void annotations
      .duplicatePages(plan.pages, index, pdfDocument.numPages, joins)
      .then((landed) => {
        if (landed) {
          notice.raise(
            at === undefined ? "pagesPastedToEnd" : "pagesPasted",
            { values: at === undefined ? { count } : { at, count } },
          )
          onPagesLanded(Array.from({ length: count }, (_, offset) => index + offset))
        } else {
          pageClipboard.disarmPaste()
        }
      })
  }

  /** `moving` joins `section`, the file it was dropped among. */
  const reorderPages = (order: number[], moving: number[] = [], section?: number) =>
    editingBusy()
      ? Promise.resolve(false)
      : annotations.reorderPages(
          order,
          reorderSections(pdfDocument.pages, order, new Set(moving), section),
        )

  /** Another tab's pages dragged in: copies, one undo step like a paste. The
      column they left found them standing at the release, this same turn. */
  const insertCarriedPages = (carried: CarriedPages, index: number, section?: number) =>
    !pdfDocument || !canTakeCarriedPages()
      ? null
      : annotations
          .insertPages(
            carried.sourceDocumentId,
            carried.pages,
            index,
            pdfDocument.numPages,
            section ?? sectionAt(pdfDocument.pages, index),
            { stands: pagesStanding(carried.sourceDocumentId) },
          )
          .then((landed) => {
            if (landed === "moved") {
              sourceBusy(carried.sourceDocumentId)
            }

            return landed === true
          })

  const appendCarriedPages = (carried: CarriedPages) =>
    insertCarriedPages(carried, pdfDocument.numPages + 1)

  return {
    appendCarriedPages,
    canTakeCarriedPages,
    deleteThumbnailPage,
    insertBlankPage,
    insertCarriedPages,
    menuThumbnailPage,
    pastePages,
    reorderPages,
    rotateOnePage,
    rotateThumbnailPages,
  }
}
