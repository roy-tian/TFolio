import { memo } from "react"
import { createPortal } from "react-dom"

/** The page as the document has it: a view rotation from the reading view is
    not printed (D2), so the rendered image is the page, turned or not. */
export type PrintPage = {
  pageNumber: number
  /** Null for a blank page a Save As will add, which prints as one. */
  src: string | null
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
          data-print-page={page.src === null ? undefined : page.pageNumber}
          key={page.src === null ? `blank-${page.pageNumber}` : page.pageNumber}
        >
          {page.src === null ? null : <img alt="" src={page.src} />}
        </div>
      ))}
    </div>,
    document.body,
  )
})
