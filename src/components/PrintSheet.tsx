import { memo } from "react"
import { createPortal } from "react-dom"

/** The page as the document has it: the rendered image is the page, turned
    or not. */
export type PrintPage = {
  /** True for a virtual padding blank a Save As adds after `pageNumber`. */
  blank?: boolean
  pageNumber: number
  /** Null for an unnumbered blank page, which prints as bare paper. */
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
          data-print-blank={page.blank ? page.pageNumber : undefined}
          data-print-page={page.blank ? undefined : page.pageNumber}
          key={page.blank ? `blank-${page.pageNumber}` : page.pageNumber}
        >
          {page.src === null ? null : <img alt="" src={page.src} />}
        </div>
      ))}
    </div>,
    document.body,
  )
})
