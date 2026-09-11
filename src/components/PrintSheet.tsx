import { memo } from "react"
import { createPortal } from "react-dom"

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

/** Portaled beside `#root` so the print stylesheet hides the app with one rule;
    memoized because it outlives the print that built it. */
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
