import { Fragment, useLayoutEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"

import { PaddingDismiss } from "@/components/PaddingDismiss"
import { PdfPage } from "@/components/PdfPage"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import type { CaptureHighlight } from "@/hooks/useHighlightTool"
import { ViewportHold, ViewportHoldContext } from "@/hooks/useNearViewport"
import type { RectDraft } from "@/hooks/useRectTool"
import type { TextNotePreview } from "@/hooks/useTextNoteTool"
import type { RenderEpochs } from "@/lib/annotations"
import { sheetSpreads, sheetsOf, type PaddingSheet } from "@/lib/padding"
import { dimensionsForRotation, type PdfPageInfo, type PdfSearchMatch } from "@/lib/pdf"
import type { ViewMode } from "@/lib/viewMode"
import { BOOK_GAP, CONTENT_PADDING_X, pageDisplayWidth, POINT_TO_PX } from "@/lib/zoom"

// The wheel preview already collapsed a gesture into one commit; holding the
// bitmap a little longer also coalesces rapid clicks and resize-driven fits.
// A zoom asked for after a quiet spell renders at once: waiting bought nothing.
const RENDER_SETTLE_MS = 150

export type IndexedPdfSearchMatch = {
  index: number
  match: PdfSearchMatch
}

const NO_SEARCH_MATCHES: IndexedPdfSearchMatch[] = []
// Shared, so a page with nothing of its own keeps the same prop through every
// pointermove of a drag on another page, and its memo holds.
const NO_DRAFTS: RectDraft[] = []
const NO_NOTES: TextNotePreview[] = []

function groupByPage<Item extends { pageNumber: number }>(
  items: Item[],
): ReadonlyMap<number, Item[]> {
  const byPage = new Map<number, Item[]>()

  for (const item of items) {
    const onPage = byPage.get(item.pageNumber)

    if (onPage) {
      onPage.push(item)
    } else {
      byPage.set(item.pageNumber, [item])
    }
  }

  return byPage
}

type LayoutProps = {
  activeSearchIndex: number | null
  /** The page holding the active match, the one page told which it is. */
  activeSearchPage: number | null
  captureHighlight: CaptureHighlight
  /** Width left for pages once the column's padding is taken out. */
  contentWidth: number
  documentId: number
  draftsByPage: ReadonlyMap<number, RectDraft[]>
  notesByPage: ReadonlyMap<number, TextNotePreview[]>
  /** Copies the whole document, and stands for a select-all being in force:
      absent, a page's menu falls back to whatever the reader dragged over. */
  onCopyAllText?: () => void
  /** Saves without the blank pages, from one of them. */
  onDismissPadding: () => void
  onPagePaint: (pageNumber: number, renderEpoch: number) => void
  /** The blank pages a Save As will add, shown where it will put them. */
  padding: readonly PaddingSheet[]
  pages: PdfPageInfo[]
  renderEpochs: RenderEpochs
  renderScale: number
  /** Resolved zoom; the fit modes have already been worked out against it. */
  scale: number
  searchMatchesByPage: ReadonlyMap<number, IndexedPdfSearchMatch[]>
  textEpochs: RenderEpochs
  /** The app's own select-all stands, so every page paints its bands. */
  textSelectAll: boolean
  viewRotation: number
}

// Below these a sheet has no room to say what it is, then none for its button.
const BLANK_NOTE_MIN = { height: 200, width: 260 }
const BLANK_BUTTON_MIN = { height: 48, width: 96 }

/** A blank page a Save As will add: white paper with a dashed edge, no page
    of the document's own, so no `data-page-number` for tracking to count. It
    says why it is there and how to save without it, where it has the room. */
function BlankSheet({
  onDismiss,
  rotation,
  scale,
  sheet,
}: {
  onDismiss: () => void
  rotation: number
  scale: number
  sheet: PaddingSheet
}) {
  const { t } = useTranslation()
  const shown = dimensionsForRotation(rotation, sheet.width, sheet.height)
  const height = shown.height * POINT_TO_PX * scale
  const width = shown.width * POINT_TO_PX * scale
  const fits = (room: { height: number; width: number }) =>
    height >= room.height && width >= room.width

  return (
    <div
      aria-label={t("sidebar.paddingPage")}
      className="flex shrink-0 flex-col items-center justify-center gap-3 overflow-hidden border-2 border-dashed border-zinc-300 bg-white p-4 shadow-sm"
      data-padding-after={sheet.after}
      role="group"
      style={{ height, width }}
    >
      {fits(BLANK_NOTE_MIN) ? (
        <p className="max-w-64 text-center text-sm text-neutral-500">
          {t("sidebar.paddingPage")}
        </p>
      ) : null}
      {fits(BLANK_BUTTON_MIN) ? <PaddingDismiss onDismiss={onDismiss} /> : null}
    </div>
  )
}

function SingleLayout({
  activeSearchIndex,
  activeSearchPage,
  captureHighlight,
  documentId,
  draftsByPage,
  notesByPage,
  onCopyAllText,
  onDismissPadding,
  onPagePaint,
  padding,
  pages,
  renderEpochs,
  renderScale,
  scale,
  searchMatchesByPage,
  textEpochs,
  textSelectAll,
  viewRotation,
}: LayoutProps) {
  const blanks = new Map(padding.map((sheet) => [sheet.after, sheet]))

  return pages.map((page, index) => (
    <Fragment key={`${documentId}-${index + 1}`}>
      <PdfPage
        captureHighlight={captureHighlight}
        documentId={documentId}
        drafts={draftsByPage.get(index + 1) ?? NO_DRAFTS}
        notes={notesByPage.get(index + 1) ?? NO_NOTES}
        onCopyAllText={onCopyAllText}
        onPagePaint={onPagePaint}
        page={page}
        pageNumber={index + 1}
        renderEpoch={renderEpochs[index + 1] ?? 0}
        renderScale={renderScale}
        rotation={viewRotation}
        scale={scale}
        searchMatches={searchMatchesByPage.get(index + 1) ?? NO_SEARCH_MATCHES}
        activeSearchIndex={activeSearchPage === index + 1 ? activeSearchIndex : null}
        textEpoch={textEpochs[index + 1] ?? 0}
        textSelectAll={textSelectAll}
      />
      {blanks.has(index + 1) ? (
        <BlankSheet
          onDismiss={onDismissPadding}
          rotation={viewRotation}
          scale={scale}
          sheet={blanks.get(index + 1)!}
        />
      ) : null}
    </Fragment>
  ))
}

function BookLayout({
  activeSearchIndex,
  activeSearchPage,
  captureHighlight,
  documentId,
  draftsByPage,
  notesByPage,
  onCopyAllText,
  onDismissPadding,
  onPagePaint,
  padding,
  pages,
  renderEpochs,
  renderScale,
  scale,
  searchMatchesByPage,
  textEpochs,
  textSelectAll,
  viewRotation,
}: LayoutProps) {
  // Sheets, not pages: a blank a Save As will add takes the right half of the
  // spread, so the next file opens the next spread as it will in print.
  return sheetSpreads(sheetsOf(pages.length, padding)).map((row) => {
    // Each half is as wide as the spread's wider page, keeping every spine on
    // the column's axis; the padding pushes the left page to the spine.
    const widths = row.map((sheet) =>
      pageDisplayWidth(
        sheet.kind === "page"
          ? pages[sheet.pageNumber - 1]!
          : { height: sheet.height, rotation: 0, width: sheet.width },
        viewRotation,
        scale,
      ),
    )
    const halfWidth = Math.max(...widths)

    return (
      <div
        className="flex scroll-mt-5 items-center"
        data-book-spread
        key={`${documentId}-spread-${row[0]!.kind === "page" ? row[0]!.pageNumber : 0}`}
        // Sized for a full spread even when holding a single trailing page, which
        // keeps that page in the left cell instead of centring it in the column.
        style={{
          gap: BOOK_GAP,
          paddingLeft: halfWidth - widths[0]!,
          width: halfWidth * 2 + BOOK_GAP,
        }}
      >
        {row.map((sheet) =>
          sheet.kind === "padding" ? (
            <BlankSheet
              key={`padding-${sheet.after}`}
              onDismiss={onDismissPadding}
              rotation={viewRotation}
              scale={scale}
              sheet={sheet}
            />
          ) : (
            <PdfPage
              captureHighlight={captureHighlight}
              documentId={documentId}
              drafts={draftsByPage.get(sheet.pageNumber) ?? NO_DRAFTS}
              notes={notesByPage.get(sheet.pageNumber) ?? NO_NOTES}
              onCopyAllText={onCopyAllText}
              onPagePaint={onPagePaint}
              key={`${documentId}-${sheet.pageNumber}`}
              page={pages[sheet.pageNumber - 1]}
              pageNumber={sheet.pageNumber}
              renderEpoch={renderEpochs[sheet.pageNumber] ?? 0}
              renderScale={renderScale}
              rotation={viewRotation}
              scale={scale}
              searchMatches={searchMatchesByPage.get(sheet.pageNumber) ?? NO_SEARCH_MATCHES}
              activeSearchIndex={activeSearchPage === sheet.pageNumber ? activeSearchIndex : null}
              textEpoch={textEpochs[sheet.pageNumber] ?? 0}
              textSelectAll={textSelectAll}
            />
          ),
        )}
      </div>
    )
  })
}

type PdfViewerLayoutProps = {
  activeSearchIndex: number | null
  /** The page holding the active match, the one page told which it is. */
  activeSearchPage: number | null
  captureHighlight: CaptureHighlight
  documentId: number
  drafts: RectDraft[]
  notes: TextNotePreview[]
  /** Saves without the blank pages, from one of them. */
  onDismissPadding: () => void
  onPagePaint: (pageNumber: number, renderEpoch: number) => void
  fileName: string
  padding: readonly PaddingSheet[]
  pages: PdfPageInfo[]
  renderEpochs: RenderEpochs
  scale: number
  searchMatchesByPage: ReadonlyMap<number, IndexedPdfSearchMatch[]>
  textEpochs: RenderEpochs
  /** Whether the whole document's text stands selected; the highlight over the
      runs is drawn from the attribute this sets, not by the WebView. */
  textSelectAll: boolean
  onCopyAllText: () => void
  viewMode: ViewMode
  viewRotation: number
  viewerWidth: number
  textSelectionDragging: boolean
  zoomPreviewing: boolean
  /** Bumped by every zoom the reader asks for, as against a fit following
      the viewer's size. */
  zoomRequest: number
}

/**
 * Every mode tags its pages with `data-page-number`, which is what lets page
 * tracking and navigation stay layout agnostic.
 */
export function PdfViewerLayout({
  activeSearchIndex,
  activeSearchPage,
  captureHighlight,
  documentId,
  drafts,
  notes,
  onCopyAllText,
  onDismissPadding,
  onPagePaint,
  fileName,
  padding,
  pages,
  renderEpochs,
  scale,
  searchMatchesByPage,
  textEpochs,
  textSelectAll,
  viewMode,
  viewRotation,
  viewerWidth,
  textSelectionDragging,
  zoomPreviewing,
  zoomRequest,
}: PdfViewerLayoutProps) {
  const contentWidth = Math.max(0, viewerWidth - CONTENT_PADDING_X)
  const renderScale = useDebouncedValue(scale, RENDER_SETTLE_MS, zoomRequest)
  // A zoom preview holds the page window still; a selection drag keeps what it
  // crossed mounted. Told to the pages' observers, never as a prop to each.
  const [hold] = useState(() => new ViewportHold())

  useLayoutEffect(() => {
    hold.set({ paused: zoomPreviewing, retainExited: textSelectionDragging })
  }, [hold, textSelectionDragging, zoomPreviewing])
  const draftsByPage = useMemo(() => groupByPage(drafts), [drafts])
  const notesByPage = useMemo(() => groupByPage(notes), [notes])
  const layoutProps = {
    activeSearchIndex,
    activeSearchPage,
    captureHighlight,
    contentWidth,
    documentId,
    draftsByPage,
    notesByPage,
    onCopyAllText: textSelectAll ? onCopyAllText : undefined,
    onDismissPadding,
    onPagePaint,
    padding,
    pages,
    renderEpochs,
    renderScale,
    scale,
    searchMatchesByPage,
    textEpochs,
    textSelectAll,
    viewRotation,
  }

  return (
    <div
      aria-label={fileName}
      data-pdf-viewer-layout
      data-select-all={textSelectAll}
      data-view-mode={viewMode}
      // `min-w-fit` keeps a zoomed-in page reachable: centring an overflowing
      // box would split the overflow, its left half at an unreachable offset.
      className="flex min-h-full min-w-fit flex-col items-center gap-5 px-8 py-8"
    >
      <ViewportHoldContext.Provider value={hold}>
        {viewMode === "book" ? (
          <BookLayout {...layoutProps} />
        ) : (
          <SingleLayout {...layoutProps} />
        )}
      </ViewportHoldContext.Provider>
    </div>
  )
}
