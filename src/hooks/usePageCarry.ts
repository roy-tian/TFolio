import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"

import type { TabId } from "@/lib/documentTabs"
import {
  stripSpotAt,
  TAB_SPRING_MS,
  type CarriedPages,
  type ExtractedPages,
  type Point,
  type StripSpot,
} from "@/lib/pageCarry"

/** What a drop that something took asks of the ghost. */
export type CarryLanding = {
  /** Where the ghost settles, or null to fade where it is. */
  box: { left: number; top: number } | null
  /** The ghost is down: the taker's holes may close. */
  landed: () => void
  /** Settles once the pages have landed, or been refused. */
  settled: Promise<unknown>
}

/** A document's sidebar previews, as somewhere carried pages can land. */
export type CarryTarget = {
  documentId: number
  drop: (carried: CarriedPages, point: Point) => CarryLanding | null
  leave: () => void
  /** Shows where the pages would land, or nothing with the point off it. */
  over: (carried: CarriedPages, point: Point) => void
  /** Only the shown tab's column is laid out, and only it takes pages. */
  shown: () => boolean
}

/** The window's side of a sidebar drag that has left its own column. */
export type PageCarry = {
  cancel: () => void
  /** Null where nothing takes the pages: they stay where they were. */
  drop: (carried: CarriedPages, point: Point) => CarryLanding | null
  move: (carried: CarriedPages, point: Point) => void
  /** The pages as a new PDF, with no drag to the strip: asked for by name. */
  newDocument: (pages: ExtractedPages) => void
  register: (target: CarryTarget) => () => void
}

export const PageCarryContext = createContext<PageCarry | null>(null)

export function usePageCarryContext() {
  return useContext(PageCarryContext)
}

type UsePageCarryOptions = {
  /** The tab showing now, read when the drag arrives rather than bound in. */
  activeIdRef: RefObject<TabId>
  /** Whether the tab's document would take pages now: only then is a release
      on its tab offered. */
  canAppend: (tabId: number) => boolean
  /** A tab the pages rested on, which they are then taken into. */
  onActivate: (tabId: number) => void
  /** Null where the tab's document cannot take the pages now; else settles
      once they have landed at its end, or been refused. */
  onAppend: (tabId: number, carried: CarriedPages) => Promise<unknown> | null
  /** Settles once the pages' new PDF has opened as a tab, or failed to. */
  onNewDocument: (pages: ExtractedPages) => Promise<unknown>
}

/** The tab a release would add the held pages to the end of. */
export type AppendOffer = { count: number; tabId: number }

/**
 * Pages cross to another document through the tab strip: let go on its tab,
 * they join its end; resting there opens it, and its column then shows where
 * they would land. Let go on the strip's open space, they become a new PDF.
 * Every way, the source keeps them.
 */
export function usePageCarry({
  activeIdRef,
  canAppend,
  onActivate,
  onAppend,
  onNewDocument,
}: UsePageCarryOptions) {
  const [armedTabId, setArmedTabId] = useState<number | null>(null)
  const [appendOffer, setAppendOffer] = useState<AppendOffer | null>(null)
  // The page count a release here would make a new PDF of.
  const [newDocumentOffer, setNewDocumentOffer] = useState<number | null>(null)
  const targetsRef = useRef(new Set<CarryTarget>())
  // The column last told about the drag, so its holes can be taken back once
  // the pointer leaves it for the strip or another tab.
  const overRef = useRef<CarryTarget | null>(null)
  const springRef = useRef<{
    tabId: number
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const actionsRef = useRef({ canAppend, onActivate, onAppend, onNewDocument })
  // What the strip was last told: a drag asks on every pointer move, and the
  // workspace should re-render only when the answer changes.
  const shownRef = useRef<{
    append: AppendOffer | null
    armed: number | null
    offer: number | null
  }>({
    append: null,
    armed: null,
    offer: null,
  })

  actionsRef.current = { canAppend, onActivate, onAppend, onNewDocument }

  const carry = useMemo<PageCarry>(() => {
    const showArmed = (tabId: number | null) => {
      if (shownRef.current.armed !== tabId) {
        shownRef.current.armed = tabId
        setArmedTabId(tabId)
      }
    }

    const offer = (count: number | null) => {
      if (shownRef.current.offer !== count) {
        shownRef.current.offer = count
        setNewDocumentOffer(count)
      }
    }

    const offerAppend = (next: AppendOffer | null) => {
      const shown = shownRef.current.append

      if (shown?.tabId !== next?.tabId || shown?.count !== next?.count) {
        shownRef.current.append = next
        setAppendOffer(next)
      }
    }

    const disarm = () => {
      if (springRef.current) {
        clearTimeout(springRef.current.timer)
        springRef.current = null
      }

      showArmed(null)
    }

    const arm = (tabId: number) => {
      if (springRef.current?.tabId === tabId) {
        return
      }

      disarm()
      showArmed(tabId)
      springRef.current = {
        tabId,
        timer: setTimeout(() => {
          springRef.current = null
          showArmed(null)
          actionsRef.current.onActivate(tabId)
        }, TAB_SPRING_MS),
      }
    }

    const retarget = (target: CarryTarget | null) => {
      if (overRef.current !== target) {
        overRef.current?.leave()
        overRef.current = target
      }
    }

    // The source's own column answers for itself while it shows.
    const shownTarget = (carried: CarriedPages) => {
      for (const target of targetsRef.current) {
        if (target.documentId !== carried.sourceDocumentId && target.shown()) {
          return target
        }
      }

      return null
    }

    // Another document's tab: a release there adds the pages to its end.
    const appendTabAt = (spot: StripSpot, carried: CarriedPages) =>
      spot.kind === "tab" && spot.tabId !== carried.sourceDocumentId
        ? spot.tabId
        : null

    const settle = () => {
      disarm()
      offer(null)
      offerAppend(null)
    }

    return {
      cancel: () => {
        settle()
        retarget(null)
      },
      drop: (carried, point) => {
        const spot = stripSpotAt(point)

        settle()

        if (spot) {
          retarget(null)

          const appendTo = appendTabAt(spot, carried)
          const settled =
            spot.kind === "space"
              ? actionsRef.current.onNewDocument(carried)
              : appendTo === null
                ? null
                : actionsRef.current.onAppend(appendTo, carried)

          return settled ? { box: null, landed: () => {}, settled } : null
        }

        const target = shownTarget(carried)

        if (overRef.current !== target) {
          retarget(null)
        }

        // The taker keeps its holes until the ghost is down, so it is not
        // told to leave.
        overRef.current = null

        return target?.drop(carried, point) ?? null
      },
      move: (carried, point) => {
        const spot = stripSpotAt(point)

        if (spot) {
          retarget(null)

          // A tab other than the one showing is worth waiting on; its own is
          // not, and neither is anything else on the strip.
          if (spot.kind === "tab" && spot.tabId !== activeIdRef.current) {
            arm(spot.tabId)
          } else {
            disarm()
          }

          offer(spot.kind === "space" ? carried.pages.length : null)
          const appendTo = appendTabAt(spot, carried)

          // Asked on every move, so a tab that finishes its work while the
          // pages are held over it offers itself at the next one.
          offerAppend(
            appendTo === null || !actionsRef.current.canAppend(appendTo)
              ? null
              : { count: carried.pages.length, tabId: appendTo },
          )
          return
        }

        settle()

        const target = shownTarget(carried)

        retarget(target)
        target?.over(carried, point)
      },
      newDocument: (pages) => void actionsRef.current.onNewDocument(pages),
      register: (target) => {
        targetsRef.current.add(target)

        return () => {
          targetsRef.current.delete(target)

          if (overRef.current === target) {
            overRef.current = null
          }
        }
      },
    }
  }, [activeIdRef])

  useEffect(() => carry.cancel, [carry])

  return { appendOffer, armedTabId, carry, newDocumentOffer }
}
