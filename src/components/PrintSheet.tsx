import { memo } from "react"
import { createPortal } from "react-dom"

/** One page as the printer will take it: the backend's render of everything
    the document now holds, turned the way the reader has it on screen. */
export type PrintPage = {
  pageNumber: number
  /** The viewer's own clockwise rotation, which is not in the rendered image:
      it is view state the document itself never took. */
  rotation: number
  src: string
}

type PrintSheetProps = {
  pages: PrintPage[]
}

/**
 * Everything print media shows — one page image per printed side. Portaled
 * beside `#root` so the print stylesheet can hide the whole app around it with
 * one rule, and hidden on screen, where the app itself is the document.
 *
 * Memoized: it outlives the print that built it, and a document of any length
 * would otherwise be diffed again on every scroll of the page behind it.
 */
export const PrintSheet = memo(function PrintSheet({ pages }: PrintSheetProps) {
  return createPortal(
    <div data-print-sheet="">
      {pages.map((page) => {
        const quarterTurn = page.rotation % 180 !== 0

        return (
          <div
            className="pdf-print-page"
            data-print-page={page.pageNumber}
            key={page.pageNumber}
          >
            {/* A quarter turn swaps the box the image is fitted into, so
                turning it back lands it square on the sheet. */}
            <img
              alt=""
              src={page.src}
              style={{
                height: quarterTurn ? "100cqw" : undefined,
                transform: `translate(-50%, -50%) rotate(${page.rotation}deg)`,
                width: quarterTurn ? "100cqh" : undefined,
              }}
            />
          </div>
        )
      })}
    </div>,
    document.body,
  )
})
