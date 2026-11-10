import { useEffect, useRef, useState, type RefObject } from "react"

import { landingBox } from "@/components/PageDragGhost"
import { usePageCarryContext, type CarryLanding } from "@/hooks/usePageCarry"
import type { CarriedPages, Point } from "@/lib/pageCarry"
import {
  besideColumn,
  columnEdgeStep,
  flowCells,
  flowLanding,
  pointInColumn,
} from "@/lib/pageDrag"
import type { PdfPageInfo } from "@/lib/pdf"

/** Flip keys of the holes another document's pages are about to fill: strings,
    apart from every page's numeric key. */
export const CARRY_KEY = "carry-"

/** Another document's pages, held over this column. */
export type IncomingPages = {
  /** Where among this column's pages the block lands, or null while the
      pointer is off the column. */
  at: number | null
  /** The page list `at` was measured against: an edit landing under it ends
      the preview, and the copies' own arrival is one. */
  basis: PdfPageInfo[]
  carried: CarriedPages
  /** Released, and the ghost has settled onto the holes. */
  ghostDown: boolean
  /** Released: the copies are on their way in. */
  landing: boolean
}

type UseIncomingPagesOptions = {
  /** The positioned flow of cells, every `[data-flip-key]` a child of it. */
  columnRef: RefObject<HTMLElement | null>
  documentId: number
  /** Null where the document cannot take the pages now; else settles on
      whether they landed. */
  onInsert: (carried: CarriedPages, index: number) => Promise<boolean> | null
  pages: PdfPageInfo[]
  /** The layout's places before the holes first open, for the rows to slide. */
  prime: () => void
  /** The column's scroller. */
  viewRef: RefObject<HTMLElement | null>
}

/** The sidebar column as somewhere another tab's carried pages can land:
    holes open where they would, and a release copies them in there. */
export function useIncomingPages({
  columnRef,
  documentId,
  onInsert,
  pages,
  prime,
  viewRef,
}: UseIncomingPagesOptions) {
  const carry = usePageCarryContext()
  const [incoming, setIncoming] = useState<IncomingPages | null>(null)
  const incomingRef = useRef(incoming)
  const pagesRef = useRef(pages)
  const insertRef = useRef(onInsert)

  pagesRef.current = pages
  insertRef.current = onInsert

  useEffect(() => {
    if (!carry) {
      return
    }

    let frame = 0
    let held: CarriedPages | null = null
    let point: Point | null = null

    const setNext = (next: IncomingPages | null) => {
      incomingRef.current = next
      setIncoming(next)
    }
    const shown = () => (viewRef.current?.getClientRects().length ?? 0) > 0
    // As the column's own reorder lands: read off the rows as laid out now,
    // the holes standing wherever the block last landed.
    const place = () => {
      const column = columnRef.current
      const view = viewRef.current
      const current = incomingRef.current
      const basis = pagesRef.current

      if (!column || !view || !held || !point || !shown()) {
        return
      }

      const at = besideColumn(point.x, view.getBoundingClientRect())
        ? flowLanding(
            pointInColumn(column, point),
            flowCells(column, (key) => key.startsWith(CARRY_KEY)),
            current?.basis === basis ? current.at : null,
          )
        : null

      if (current?.basis === basis && current.at === at && current.carried === held) {
        return
      }

      if (!current) {
        prime()
      }

      setNext({ at, basis, carried: held, ghostDown: false, landing: false })
    }
    const edgeScroll = () => {
      const view = viewRef.current
      const step =
        view && point && shown() ? columnEdgeStep(point, view.getBoundingClientRect()) : 0

      if (step !== 0) {
        view!.scrollBy({ top: step })
        place()
      }

      frame = requestAnimationFrame(edgeScroll)
    }
    const letGo = () => {
      cancelAnimationFrame(frame)
      frame = 0
      held = null
      point = null
    }

    const unregister = carry.register({
      documentId,
      drop: (carried, at): CarryLanding | null => {
        if (incomingRef.current?.landing) {
          return null
        }

        held = carried
        point = at
        place()
        letGo()

        const current = incomingRef.current
        const settled =
          current && current.at !== null && current.basis === pagesRef.current
            ? insertRef.current(carried, current.at + 1)
            : null

        if (!current || !settled) {
          setNext(null)
          return null
        }

        const column = columnRef.current
        const box = column
          ? landingBox(
              column,
              column.querySelector(`[data-flip-key="${CARRY_KEY}${carried.lead}"]`),
              "[data-drag-hole]",
              viewRef.current,
            )
          : null
        // Done once both the ghost is down and the copies have landed, in
        // whichever order: until then the block's holes hold their place.
        let down = false
        let done = false
        let state: IncomingPages = { ...current, landing: true }
        const close = () => {
          if (incomingRef.current !== state) {
            return
          }

          if (down && done) {
            setNext(null)
          } else if (down) {
            state = { ...state, ghostDown: true }
            setNext(state)
          }
        }

        setNext(state)
        void settled
          .catch(() => false)
          .then(() => {
            done = true
            close()
          })

        return {
          box,
          landed: () => {
            down = true
            close()
          },
          settled,
        }
      },
      leave: () => {
        letGo()

        if (incomingRef.current && !incomingRef.current.landing) {
          setNext(null)
        }
      },
      over: (carried, at) => {
        if (incomingRef.current?.landing) {
          return
        }

        if (!held) {
          frame = requestAnimationFrame(edgeScroll)
        }

        held = carried
        point = at
        place()
      },
      shown,
    })

    return () => {
      unregister()
      letGo()
    }
  }, [carry, columnRef, documentId, prime, viewRef])

  return incoming
}
