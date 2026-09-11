import { useCallback, useEffect, useRef } from "react"

import { storeRecentPdfView, type RecentPdfView } from "@/lib/recentFiles"

const RECENT_VIEW_WRITE_INTERVAL_MS = 250

type UseRecentViewOptions = {
  /** The path this document's view is stored under; absent for documents with
      no file of their own yet. */
  recentPath: string | undefined
}

/**
 * The reading position's durable half: the debounced write queue that keeps a
 * slow older write from landing after a newer one, and the flush points that
 * make a view survive a refresh even as it scrolls.
 */
export function useRecentView({ recentPath }: UseRecentViewOptions) {
  const pendingRecentViewRef = useRef<{
    path: string
    version: number
    view: RecentPdfView
  } | null>(null)
  const writtenRecentViewVersionRef = useRef(0)
  const recentViewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const recentViewWriteChainRef = useRef<Promise<void>>(Promise.resolve())

  const flushRecentView = useCallback(() => {
    const pending = pendingRecentViewRef.current

    if (!pending || pending.version <= writtenRecentViewVersionRef.current) {
      return recentViewWriteChainRef.current
    }

    writtenRecentViewVersionRef.current = pending.version
    // Tauri calls are asynchronous: without this chain a slower older write
    // could land after a newer one and put the document back too far.
    recentViewWriteChainRef.current = recentViewWriteChainRef.current.then(() =>
      storeRecentPdfView(pending.path, pending.view),
    )

    return recentViewWriteChainRef.current
  }, [])

  const queueRecentView = useCallback(
    (view: RecentPdfView) => {
      if (!recentPath) {
        return
      }

      const version = (pendingRecentViewRef.current?.version ?? 0) + 1
      pendingRecentViewRef.current = { path: recentPath, version, view }

      // Leading and trailing samples, one trailing timer: a long scroll is
      // durable as it goes, its resting point written a quarter second later.
      if (recentViewTimerRef.current !== undefined) {
        return
      }

      flushRecentView()
      recentViewTimerRef.current = setTimeout(() => {
        recentViewTimerRef.current = undefined
        flushRecentView()
      }, RECENT_VIEW_WRITE_INTERVAL_MS)
    },
    [flushRecentView, recentPath],
  )

  const rememberViewNow = useCallback(
    (sample: () => RecentPdfView | null) => {
      const view = sample()

      if (view) {
        queueRecentView(view)
      }

      flushRecentView()

      return recentViewWriteChainRef.current
    },
    [flushRecentView, queueRecentView],
  )

  useEffect(() => {
    window.addEventListener("pagehide", flushRecentView)

    return () => {
      window.removeEventListener("pagehide", flushRecentView)
      clearTimeout(recentViewTimerRef.current)
      recentViewTimerRef.current = undefined
      flushRecentView()
    }
  }, [flushRecentView])

  return {
    queueRecentView,
    rememberViewNow,
  }
}
