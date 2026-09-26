import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { invoke } from "@tauri-apps/api/core"

import type { RenderEpochs } from "@/lib/annotations"
import type {
  PdfPageInfo,
  PdfSearchMatch,
  PdfSearchOutcome,
} from "@/lib/pdf"
import {
  firstSearchMatchFromPage,
  searchRevealOffset,
  stepSearchMatch,
} from "@/lib/pdfSearch"
import type { ViewMode } from "@/lib/viewMode"

const SEARCH_DEBOUNCE_MS = 180
const SEARCH_REVEAL_TIMEOUT_MS = 3000

type UseDocumentSearchOptions = {
  active: boolean
  /** The tracked page, read when a run lands: the first match is the one
      nearest where the reader is, not where they were when typing began. */
  currentPageRef: RefObject<number>
  documentId: number | undefined
  documentPages: PdfPageInfo[]
  /** Steps the session aside for a match found while on the grid: queues the
      page seek and leaves the grid for the page view that can draw it. */
  onMatchInGrid: (pageNumber: number) => void
  /** The panel's id in the DOM, which the input and result focus target. */
  sessionId: number
  setCurrentPage: (pageNumber: number) => void
  /** Serves the reveal below: page text edits can redraw or drop highlights. */
  textEpochs: RenderEpochs
  viewerRef: RefObject<HTMLElement | null>
  viewMode: ViewMode
}

/**
 * Search state for one document: the debounced PDFium text run, match
 * stepping, and the scroll that brings the active match on screen.
 */
export function useDocumentSearch({
  active,
  currentPageRef,
  documentId,
  documentPages,
  onMatchInGrid,
  sessionId,
  setCurrentPage,
  textEpochs,
  viewerRef,
  viewMode,
}: UseDocumentSearchOptions) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<PdfSearchMatch[]>([])
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const [limitReached, setLimitReached] = useState(false)
  const generationRef = useRef(0)
  const cancellationRef = useRef<Promise<void>>(Promise.resolve())
  // The match the reader was last brought to. Entering the grid, or coming
  // back to this tab, is not a request to be taken there again.
  const revealedRef = useRef<{
    index: number
    matches: PdfSearchMatch[]
  } | null>(null)

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(
        `[data-document-search="${sessionId}"] input`,
      )

      input?.focus()
      input?.select()
    })
  }, [sessionId])

  const openSearch = useCallback(() => {
    setSearchOpen(true)
    focusInput()
  }, [focusInput])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-document-session="${sessionId}"] [data-slot="pdf-search-trigger"]`,
        )
        ?.focus()
    })
  }, [sessionId])

  // PDFium's page text, not the DOM's: it reaches virtualized pages whose text
  // layer is not mounted. Debounced, so IME compositions do not launch passes.
  // Not keyed to `active`: a tab sent to the background keeps its results and
  // the match it stood on, and comes back without a new search moving the page.
  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    let running = false

    setFailed(false)
    setLimitReached(false)
    setMatches([])
    setActiveIndex(null)

    const trimmed = query.trim()

    if (!searchOpen || trimmed.length === 0 || !documentId) {
      setSearching(false)

      return
    }

    setSearching(true)
    const timer = setTimeout(() => {
      void (async () => {
        // A new term waits for the old run's cancellation command first: the
        // search itself releases the PDFium lock at the next page boundary.
        await cancellationRef.current

        if (generationRef.current !== generation) {
          return
        }

        running = true

        try {
          const outcome = await invoke<PdfSearchOutcome>("search_pdf_text", {
            documentId,
            query: trimmed,
          })

          if (generationRef.current !== generation || outcome.cancelled) {
            return
          }

          setLimitReached(outcome.limitReached)
          setMatches(outcome.matches)
          setActiveIndex(
            firstSearchMatchFromPage(outcome.matches, currentPageRef.current),
          )
        } catch {
          if (generationRef.current === generation) {
            setFailed(true)
          }
        } finally {
          running = false

          if (generationRef.current === generation) {
            setSearching(false)
          }
        }
      })()
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)

      if (generationRef.current === generation) {
        generationRef.current += 1
      }

      if (running) {
        cancellationRef.current = invoke<boolean>("cancel_pdf_search", {
          documentId,
        }).then(
          () => undefined,
          () => undefined,
        )
      }
    }
  }, [
    documentId,
    documentPages,
    searchOpen,
    query,
    textEpochs,
  ])

  const matchesByPage = useMemo(() => {
    const byPage = new Map<
      number,
      Array<{ index: number; match: PdfSearchMatch }>
    >()

    matches.forEach((match, index) => {
      const pageMatches = byPage.get(match.pageNumber) ?? []
      pageMatches.push({ index, match })
      byPage.set(match.pageNumber, pageMatches)
    })

    return byPage
  }, [matches])

  const stepMatch = useCallback(
    (direction: -1 | 1) => {
      setActiveIndex((current) =>
        stepSearchMatch(current, matches.length, direction),
      )
    },
    [matches.length],
  )

  // Brings the active match on screen. A grid has nowhere to draw a result, so
  // the session is sent back to the page view, whose pending seek brings the
  // page up before the rectangle-level reveal below.
  useEffect(() => {
    if (!active || !searchOpen || activeIndex === null) {
      return
    }

    const match = matches[activeIndex]
    const viewer = viewerRef.current

    if (!match || !viewer) {
      return
    }

    const revealed = revealedRef.current

    if (revealed?.index === activeIndex && revealed.matches === matches) {
      return
    }

    currentPageRef.current = match.pageNumber
    setCurrentPage(match.pageNumber)

    if (viewMode === "thumbnail") {
      onMatchInGrid(match.pageNumber)

      return
    }

    revealedRef.current = { index: activeIndex, matches }

    const interruptScroll = () => viewer.scrollTo({
      behavior: "instant",
      left: viewer.scrollLeft,
      top: viewer.scrollTop,
    })
    interruptScroll()

    const activeMatchRects = () =>
      Array.from(
        viewer.querySelectorAll<HTMLElement>(
          `[data-search-match="${activeIndex}"]`,
        ),
        (rectangle) => rectangle.getBoundingClientRect(),
      )

    const page = viewer.querySelector<HTMLElement>(
      `[data-page-number="${match.pageNumber}"]`,
    )
    const pageBox = page?.getBoundingClientRect()
    const viewerBox = viewer.getBoundingClientRect()

    // A page off screen, sideways included, is virtualized with no highlight to
    // measure: bring it over first so the near-viewport observer attaches one.
    if (
      activeMatchRects().length === 0 &&
      (!pageBox ||
        pageBox.bottom <= viewerBox.top ||
        pageBox.top >= viewerBox.bottom ||
        pageBox.right <= viewerBox.left ||
        pageBox.left >= viewerBox.right)
    ) {
      page?.scrollIntoView({
        behavior: "auto",
        block: "center",
        inline: "center",
      })
    }

    let frame = 0
    const deadline = performance.now() + SEARCH_REVEAL_TIMEOUT_MS
    const revealMatch = () => {
      const rects = activeMatchRects()

      if (rects.length > 0) {
        const offset = searchRevealOffset(
          rects,
          viewer.getBoundingClientRect(),
          document
            .querySelector<HTMLElement>(
              `[data-document-search="${sessionId}"] [data-slot="pdf-search"]`,
            )
            ?.getBoundingClientRect() ?? null,
          {
            minLeft: -viewer.scrollLeft,
            maxLeft: viewer.scrollWidth - viewer.clientWidth - viewer.scrollLeft,
            minTop: -viewer.scrollTop,
            maxTop: viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop,
          },
        )

        if (offset) {
          viewer.scrollTo({
            behavior: "smooth",
            left: viewer.scrollLeft + offset.left,
            top: viewer.scrollTop + offset.top,
          })
        }

        return
      }

      // The layer is drawn once PDFium has the page back, which the seek above
      // only starts; a heavy page can take a good part of a second.
      if (performance.now() < deadline) {
        frame = requestAnimationFrame(revealMatch)
      }
    }

    frame = requestAnimationFrame(revealMatch)

    return () => {
      cancelAnimationFrame(frame)
      interruptScroll()
    }
  }, [
    active,
    activeIndex,
    matches,
    onMatchInGrid,
    searchOpen,
    sessionId,
    setCurrentPage,
    viewerRef,
    viewMode,
  ])

  return {
    activeIndex,
    closeSearch,
    searchOpen,
    failed,
    limitReached,
    matches,
    matchesByPage,
    openSearch,
    query,
    searching,
    setQuery,
    setSearchOpen,
    stepMatch,
  }
}
