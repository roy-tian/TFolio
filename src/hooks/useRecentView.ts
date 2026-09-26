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
  // What the last write sent: a scroll that came back to rest where it was,
  // or a flush with nothing new, rewrites nothing.
  const writtenRecentViewRef = useRef<string | null>(null)
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

    const written = JSON.stringify([pending.path, pending.view])

    if (written === writtenRecentViewRef.current) {
      return recentViewWriteChainRef.current
    }

    writtenRecentViewRef.current = written
    // Tauri calls are asynchronous: without this chain a slower older write
    // could land after a newer one and put the document back too far.
    recentViewWriteChainRef.current = recentViewWriteChainRef.current.then(
      async () => {
        // One that did not land — a failed call, or a path the recent list no
        // longer holds — must not stop the same view being sent again.
        if (
          !(await storeRecentPdfView(pending.path, pending.view)) &&
          writtenRecentViewRef.current === written
        ) {
          writtenRecentViewRef.current = null
        }
      },
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

      // Trailing samples only, one timer: a long scroll is written at most
      // four times a second as it goes, and its resting point a quarter second
      // after it stops; a tab switch, a close or a page hide flushes at once.
      if (recentViewTimerRef.current !== undefined) {
        return
      }

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
