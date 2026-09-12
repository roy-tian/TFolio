import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"

import type {
  DocumentSessionHandle,
  PageDragEvent,
} from "@/components/DocumentSession"
import { HOME_TAB_ID, type TabId } from "@/lib/documentTabs"
import { TAB_SPRING_MS, type PageHandoffPlace } from "@/lib/pageDrag"

/** What a document's grid hands a drag that has left it, before the session
    binds its own id into the `PageHandoff` the grid takes. */
export type PageHandoffTarget = {
  cancel: () => void
  claim: (
    sourceDocumentId: number,
    point: { x: number; y: number },
  ) => PageHandoffPlace | null
  drop: (
    sourceDocumentId: number,
    point: { x: number; y: number },
    pages: number[],
  ) => void
}

type UsePageHandoffOptions = {
  /** The tab showing now. Read through a ref because the drag arrives on
      listeners bound once, outside any render that could refresh a value. */
  activeIdRef: RefObject<TabId>
  onActivate: (tabId: TabId) => void
  sessions: RefObject<Map<number, DocumentSessionHandle>>
}

function tabAtPoint(point: { x: number; y: number }) {
  const element = document.elementFromPoint(point.x, point.y)
  const tab = element?.closest<HTMLElement>("[data-document-tab]") ?? null
  const tabId = tab ? Number(tab.dataset.documentTab) : null

  return {
    onStrip: Boolean(element?.closest("[data-tab-strip]")),
    tabId: tabId !== null && Number.isInteger(tabId) ? tabId : null,
  }
}

/**
 * The tab strip is the way across; anywhere else a release lands nothing,
 * rather than quietly reordering the document left behind.
 */
export function usePageHandoff({
  activeIdRef,
  onActivate,
  sessions,
}: UsePageHandoffOptions): {
  armedTabId: number | null
  handoff: PageHandoffTarget
} {
  const [armedTabId, setArmedTabId] = useState<number | null>(null)
  const springRef = useRef<{
    tabId: number
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  // The document last told about the drag, so its insertion line can be taken
  // back when the pointer leaves it for the strip or for another tab.
  const targetRef = useRef<number | null>(null)

  const disarm = useCallback(() => {
    if (springRef.current) {
      clearTimeout(springRef.current.timer)
      springRef.current = null
    }

    setArmedTabId(null)
  }, [])

  const tell = useCallback(
    (documentId: number | null, event: PageDragEvent) =>
      documentId !== null &&
      (sessions.current.get(documentId)?.onPageDrag(event) ?? false),
    [sessions],
  )

  const handoff = useMemo<PageHandoffTarget>(() => {
    const targetOf = (sourceDocumentId: number) => {
      const activeId = activeIdRef.current

      return activeId !== HOME_TAB_ID && activeId !== sourceDocumentId
        ? activeId
        : null
    }

    const arm = (tabId: number) => {
      if (springRef.current?.tabId === tabId) {
        return
      }

      disarm()
      setArmedTabId(tabId)
      springRef.current = {
        tabId,
        timer: setTimeout(() => {
          springRef.current = null
          setArmedTabId(null)
          onActivate(tabId)
          // The drag is made of pages, so the document it opens shows its own:
          // the grid is the one view with gaps between them to drop into.
          sessions.current.get(tabId)?.showThumbnails()
        }, TAB_SPRING_MS),
      }
    }

    const retarget = (documentId: number | null) => {
      if (targetRef.current !== documentId) {
        tell(targetRef.current, { kind: "leave" })
        targetRef.current = documentId
      }
    }

    return {
      cancel: () => {
        disarm()
        retarget(null)
      },
      claim: (sourceDocumentId, point) => {
        const strip = tabAtPoint(point)
        const target = targetOf(sourceDocumentId)

        if (strip.onStrip) {
          // A tab other than the one already showing is worth waiting on; its
          // own is not, and neither is the space around them.
          if (strip.tabId !== null && strip.tabId !== activeIdRef.current) {
            arm(strip.tabId)
          } else {
            disarm()
          }

          // The pointer is over the strip, not over any grid: whatever line the
          // document behind it was drawing is no longer pointing at anything.
          retarget(null)
          return "carried"
        }

        disarm()
        retarget(target)

        if (target === null) {
          return null
        }

        // Still the workspace's where that document has no gap under the
        // pointer — its header, say: the pages are carried, and land nowhere.
        return tell(target, { kind: "over", point }) ? "grid" : "carried"
      },
      drop: (sourceDocumentId, point, pages) => {
        disarm()

        const target = targetOf(sourceDocumentId)

        retarget(null)
        tell(target, { kind: "drop", pages, point, sourceDocumentId })
      },
    }
  }, [activeIdRef, disarm, onActivate, sessions, tell])

  useEffect(() => disarm, [disarm])

  return { armedTabId, handoff }
}
