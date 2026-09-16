import { useCallback, useEffect, useState } from "react"
import type { RefObject } from "react"

import type { DocumentNotices } from "@/hooks/useNotices"
import type { useAnnotations } from "@/hooks/useAnnotations"
import type { PdfDocumentInfo } from "@/lib/pdf"
import { dropHitAt, insertIndexForHit } from "@/lib/fileDrop"
import { isPdfPath } from "@/lib/pdf"
import type { ViewMode } from "@/lib/viewMode"

import type { FileDragEvent, PageDragEvent } from "@/components/DocumentSession"

type UseGridDropOptions = {
  active: boolean
  annotations: ReturnType<typeof useAnnotations>
  /** The document's own record, read at insert time: a structure change writes
      it before the render that would refresh a captured value. */
  documentRef: RefObject<PdfDocumentInfo | null>
  notice: DocumentNotices
  viewMode: ViewMode
  viewerRef: RefObject<HTMLElement | null>
}

/**
 * The thumbnail grid's half of the window's drag-and-drop: where a dragged PDF
 * or a stack of pages from another document would land, and the claim that
 * keeps the workspace from opening them as tabs instead.
 */
export function useGridDrop({
  active,
  annotations,
  documentRef,
  notice,
  viewMode,
  viewerRef,
}: UseGridDropOptions) {
  // Only the insertion line reads this; every drop resolves the point again,
  // so a stale index can never place anything.
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  // Each PDF in drop order, advancing by what the backend says the insert
  // added — the document's own growth could count an edit landing in between.
  const insertFiles = useCallback(
    async (paths: string[], index: number) => {
      let at = index

      for (const path of paths) {
        at += await annotations.insertFile(
          path,
          at,
          documentRef.current?.numPages ?? 0,
        )
      }
    },
    [annotations],
  )

  // A desktop PDF, from the window's one drag handler (see `App.tsx`). Only the
  // grid takes one — it is the one surface where a position can be pointed at.
  const handleFileDrag = useCallback(
    (event: FileDragEvent): boolean => {
      const viewer = viewerRef.current

      if (
        event.kind === "leave" ||
        !active ||
        !viewer ||
        viewMode !== "thumbnail"
      ) {
        setDropIndex(null)
        return false
      }

      // An untakeable drag goes to the workspace, whose target honestly says
      // the file opens; null paths mean the window never heard them, not none.
      if (!(event.paths?.some(isPdfPath) ?? true)) {
        setDropIndex(null)
        return false
      }

      // Resolved from the point every time, drop included: the drawn index
      // belongs to its render, and a file lands where the pointer is now.
      const index = insertIndexForHit(
        dropHitAt(event.point, viewer),
        event.point.x,
      )

      setDropIndex(event.kind === "over" ? index : null)

      if (index === null) {
        return false
      }

      if (event.kind === "over") {
        return true
      }

      // Claimed either way: a drop it cannot act on is an error shown here, not
      // a tab opened behind the reader's back; the busy case is the one such.
      if (annotations.isStructureBusyNow()) {
        notice.raise("editInFlight")
      } else {
        // Only PDFs become pages; a mixed drag's other files are said so, not
        // silently gone.
        const insertable = event.paths.filter(isPdfPath)
        const ignored = event.paths.length - insertable.length

        if (ignored > 0) {
          notice.raise("insertIgnoredFiles", { values: { count: ignored } })
        }

        void insertFiles(insertable, index)
      }

      return true
    },
    [active, annotations, insertFiles, notice, viewMode],
  )

  /**
   * Pages from another document's grid, brought here once the workspace sprung
   * this tab open — landing as a dropped file would, as copies the source keeps.
   */
  const handlePageDrag = useCallback(
    (event: PageDragEvent): boolean => {
      const viewer = viewerRef.current

      if (
        event.kind === "leave" ||
        !active ||
        !viewer ||
        viewMode !== "thumbnail"
      ) {
        setDropIndex(null)
        return false
      }

      const index = insertIndexForHit(
        dropHitAt(event.point, viewer),
        event.point.x,
      )

      setDropIndex(event.kind === "over" ? index : null)

      if (index === null) {
        return false
      }

      if (event.kind === "over") {
        return true
      }

      // Claimed either way, as a file drop over this grid is: the one case it
      // cannot act on is an edit already renumbering the gap it was read off.
      if (annotations.isStructureBusyNow()) {
        notice.raise("editInFlight")
      } else {
        void annotations.insertPages(
          event.sourceDocumentId,
          event.pages,
          index,
          // Off the ref, as an inserted file's bound is: a structure change
          // writes it before the render that would refresh a captured value.
          documentRef.current?.numPages ?? 0,
        )
      }

      return true
    },
    [active, annotations, documentRef, notice, viewMode],
  )

  // A drag finished elsewhere — a tab switch, the wizard taking the drop —
  // never sends a `leave`, so the line it drew would outlive the drag.
  useEffect(() => {
    if (!active) {
      setDropIndex(null)
    }
  }, [active])

  return {
    dropIndex,
    handleFileDrag,
    handlePageDrag,
  }
}
