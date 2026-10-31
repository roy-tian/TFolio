import { memo, useLayoutEffect, useRef } from "react"
import { useTranslation } from "react-i18next"

import { PdfThumbnail } from "@/components/PdfThumbnail"
import { useCurrentPage, type CurrentPage } from "@/hooks/useCurrentPage"
import { useNearViewport } from "@/hooks/useNearViewport"
import type { RenderEpochs } from "@/lib/annotations"
import type { PdfPageInfo } from "@/lib/pdf"

// A column shows a handful of pages; keeping pixels further out than a few
// screens would hold a long document's every preview for one scroll through.
const RETAIN_MARGIN = "1500px 0px"

type SidebarThumbnailsProps = {
  /** A background tab's column is laid out only once its tab is shown. */
  active: boolean
  currentPage: CurrentPage
  documentId: number
  onNavigate: (pageNumber: number) => void
  pages: PdfPageInfo[]
  renderEpochs: RenderEpochs
  rotations: number[]
  /** Follow each page through a reorder, so its painted preview moves with it. */
  thumbnailKeys: number[]
}

export function SidebarThumbnails({
  active,
  currentPage,
  documentId,
  onNavigate,
  pages,
  renderEpochs,
  rotations,
  thumbnailKeys,
}: SidebarThumbnailsProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const current = useCurrentPage(currentPage)
  const followedRef = useRef<number | null>(null)

  // Only when the reader's page changes, never on every render: a reader
  // scrolling the column to look further ahead must not be pulled back.
  useLayoutEffect(() => {
    const list = listRef.current
    const paper = list?.querySelector<HTMLElement>(
      `[data-thumbnail-page="${current}"]`,
    )

    if (
      !active ||
      !list ||
      !paper ||
      followedRef.current === current ||
      list.getClientRects().length === 0
    ) {
      return
    }

    // Measured against the column itself: `scrollIntoView` would also scroll
    // the clipped panels the column sits in.
    const listBox = list.getBoundingClientRect()
    const paperBox = paper.getBoundingClientRect()
    const margin = 12
    const instant = followedRef.current === null

    followedRef.current = current

    if (paperBox.top < listBox.top + margin) {
      list.scrollBy({
        behavior: instant ? "instant" : "smooth",
        top: paperBox.top - listBox.top - margin,
      })
    } else if (paperBox.bottom > listBox.bottom - margin) {
      list.scrollBy({
        behavior: instant ? "instant" : "smooth",
        top: paperBox.bottom - listBox.bottom + margin,
      })
    }
  }, [active, current])

  return (
    <div
      aria-label={t("sidebar.thumbnails")}
      className="h-full overflow-y-auto overscroll-contain px-2 pt-3 pb-4"
      data-slot="sidebar-thumbnails"
      data-thumbnail-scroll-root
      ref={listRef}
      role="navigation"
    >
      <ol className="flex flex-col items-center gap-3">
        {pages.map((page, index) => {
          const pageNumber = index + 1

          return (
            <SidebarThumbnail
              documentId={documentId}
              intrinsicRotation={page.rotation}
              isCurrent={current === pageNumber}
              key={thumbnailKeys[index] ?? index}
              onNavigate={onNavigate}
              pageHeight={page.height}
              pageNumber={pageNumber}
              pageWidth={page.width}
              renderEpoch={renderEpochs[pageNumber] ?? 0}
              rotation={rotations[index] ?? 0}
            />
          )
        })}
      </ol>
    </div>
  )
}

const noop = () => {}

/** Memoised on primitives alone, so the reader's page moving re-renders the
    two previews it moves between, not the column. */
const SidebarThumbnail = memo(function SidebarThumbnail({
  documentId,
  intrinsicRotation,
  isCurrent,
  onNavigate,
  pageHeight,
  pageNumber,
  pageWidth,
  renderEpoch,
  rotation,
}: {
  documentId: number
  intrinsicRotation: number
  isCurrent: boolean
  onNavigate: (pageNumber: number) => void
  pageHeight: number
  pageNumber: number
  pageWidth: number
  renderEpoch: number
  rotation: number
}) {
  const itemRef = useRef<HTMLLIElement>(null)
  const nearView = useNearViewport(itemRef, RETAIN_MARGIN)

  return (
    <li ref={itemRef}>
      <PdfThumbnail
        deleteDisabled
        documentId={documentId}
        intrinsicRotation={intrinsicRotation}
        isCurrent={isCurrent}
        isCut={false}
        isSelected={false}
        onDelete={noop}
        onOpen={onNavigate}
        onSelect={onNavigate}
        pageHeight={pageHeight}
        pageNumber={pageNumber}
        pageWidth={pageWidth}
        renderEpoch={renderEpoch}
        retainBitmap={nearView}
        rotation={rotation}
        selectedCount={0}
        showControls={false}
        surface="sidebar"
      />
    </li>
  )
})
