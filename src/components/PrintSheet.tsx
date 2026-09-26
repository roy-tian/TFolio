import { memo } from "react"
import { createPortal } from "react-dom"

/** The page as the document has it: a view rotation from the reading view is
    not printed (D2), so the rendered image is the page, turned or not. */
export type PrintPage = {
  pageNumber: number
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
      {pages.map((page) => (
        <div
          className="pdf-print-page"
          data-print-page={page.pageNumber}
          key={page.pageNumber}
        >
          <img alt="" src={page.src} />
        </div>
      ))}
    </div>,
    document.body,
  )
})
