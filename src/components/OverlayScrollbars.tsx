import { useLayoutEffect, useRef, type RefObject } from "react"

import {
  scrollbarsEmulated,
  scrollPerThumbPixel,
  thumbGeometry,
} from "@/lib/overlayScrollbars"
import { cn } from "@/lib/utils"
import { normalizeWheelDelta } from "@/lib/zoom"

// The tracks' `w-3` and `h-3`, or `w-1.5` and `h-1.5` thin: the corner each
// leaves the other.
const TRACK_THICKNESS = 12
const THIN_TRACK_THICKNESS = 6
const HIDE_DELAY_MS = 1000
// A page less a little, so a line of context carries over, as native bars do.
const PAGE_STEP = 0.875

type OverlayScrollbarsProps = {
  /** Where the bars lie; by default over the whole positioned parent, which
      must share the viewport's box. */
  className?: string
  /** For a strip too short to give a full bar's width of itself to the bar. */
  thin?: boolean
  viewportRef: RefObject<HTMLElement | null>
}

/**
 * Bars for a scroll box marked `overlay-scroll-viewport`, drawn over its content
 * the way macOS draws its own: shown while the box scrolls or the pointer is on
 * them, and taking no width from the content. macOS keeps its native bars.
 *
 * A sibling of the viewport, never inside it, where it would scroll away.
 *
 * Not Base UI's Scroll Area: on WebKit it sets inherited custom properties on
 * the viewport every scroll, restyling a page's whole text layer per frame, and
 * it hides native bars with an injected `<style>` the CSP refuses.
 */
export function OverlayScrollbars(props: OverlayScrollbarsProps) {
  return scrollbarsEmulated() ? <EmulatedScrollbars {...props} /> : null
}

type Axis = {
  vertical: boolean
  /** Whether the box's overflow style lets it scroll this way at all. */
  scrolls: boolean
  track: HTMLDivElement
  thumb: HTMLDivElement
  // As last placed, for drags and track presses.
  clientSize: number
  scrollSize: number
  thumbOffset: number
  thumbSize: number
  trackSize: number
}

type Drag = {
  axis: Axis
  pointerId: number
  pointer: number
  scroll: number
  scrollPerPixel: number
}

function EmulatedScrollbars({ className, thin = false, viewportRef }: OverlayScrollbarsProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const yTrackRef = useRef<HTMLDivElement>(null)
  const yThumbRef = useRef<HTMLDivElement>(null)
  const xTrackRef = useRef<HTMLDivElement>(null)
  const xThumbRef = useRef<HTMLDivElement>(null)

  // A layout effect, so the first placement lands before the first paint.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const root = rootRef.current
    const yTrack = yTrackRef.current
    const yThumb = yThumbRef.current
    const xTrack = xTrackRef.current
    const xThumb = xThumbRef.current

    if (!viewport || !root || !yTrack || !yThumb || !xTrack || !xThumb) {
      return
    }

    const corner = thin ? THIN_TRACK_THICKNESS : TRACK_THICKNESS
    const style = getComputedStyle(viewport)
    const makeAxis = (
      vertical: boolean,
      overflow: string,
      track: HTMLDivElement,
      thumb: HTMLDivElement,
    ): Axis => ({
      clientSize: 0,
      scrollSize: 0,
      scrolls: overflow === "auto" || overflow === "scroll",
      thumb,
      thumbOffset: 0,
      thumbSize: -1,
      track,
      trackSize: 0,
      vertical,
    })
    const y = makeAxis(true, style.overflowY, yTrack, yThumb)
    const x = makeAxis(false, style.overflowX, xTrack, xThumb)
    let drag: Drag | null = null
    let hovered: Axis | null = null
    let lastActivity = 0
    let hideTimer: ReturnType<typeof setTimeout> | undefined

    const placeAxis = (
      axis: Axis,
      overflows: boolean,
      scroll: number,
      scrollSize: number,
      clientSize: number,
      trackSize: number,
    ) => {
      if (axis.track.hidden === overflows) {
        axis.track.hidden = !overflows
      }

      if (!overflows) {
        // A track hidden under the pointer never hears it leave.
        if (hovered === axis) {
          hovered = null
          delete axis.track.dataset.expanded
          hideLater()
        }

        return
      }

      const { offset, size } = thumbGeometry(scroll, scrollSize, clientSize, trackSize)

      if (size !== axis.thumbSize) {
        axis.thumb.style[axis.vertical ? "height" : "width"] = `${size}px`
      }

      axis.thumb.style.transform = axis.vertical
        ? `translate3d(0, ${offset}px, 0)`
        : `translate3d(${offset}px, 0, 0)`
      Object.assign(axis, {
        clientSize,
        scrollSize,
        thumbOffset: offset,
        thumbSize: size,
        trackSize,
      })
    }

    // Every read ahead of every write, so a placement forces one layout at most
    // and touches nothing but the bars: never the content's styles.
    const place = () => {
      const { clientHeight, clientWidth, scrollHeight, scrollLeft, scrollTop, scrollWidth } =
        viewport
      const height = root.clientHeight
      const width = root.clientWidth
      const overflowsY = y.scrolls && scrollHeight > clientHeight
      const overflowsX = x.scrolls && scrollWidth > clientWidth

      placeAxis(
        y,
        overflowsY,
        scrollTop,
        scrollHeight,
        clientHeight,
        height - (overflowsX ? corner : 0),
      )
      placeAxis(
        x,
        overflowsX,
        scrollLeft,
        scrollWidth,
        clientWidth,
        width - (overflowsY ? corner : 0),
      )
    }

    const hideIfIdle = () => {
      hideTimer = undefined

      // Leaving the bar or letting go schedules this again.
      if (drag || hovered) {
        return
      }

      const remaining = lastActivity + HIDE_DELAY_MS - performance.now()

      if (remaining > 0) {
        hideTimer = setTimeout(hideIfIdle, remaining)
        return
      }

      delete root.dataset.visible
    }
    // One timer that re-arms itself, rather than one replaced on every scroll.
    const hideLater = () => {
      lastActivity = performance.now()
      hideTimer ??= setTimeout(hideIfIdle, HIDE_DELAY_MS)
    }
    const show = () => {
      if (root.dataset.visible === undefined) {
        root.dataset.visible = ""
      }

      hideLater()
    }

    const onScroll = () => {
      place()
      show()
    }

    const scrollAlong = (axis: Axis, to: number) => {
      if (axis.vertical) {
        viewport.scrollTop = to
      } else {
        viewport.scrollLeft = to
      }
    }

    const listeners = [y, x].map((axis) => {
      const { track, thumb, vertical } = axis
      const along = (event: PointerEvent) => (vertical ? event.clientY : event.clientX)

      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) {
          return
        }

        // The press is the bar's: no focus moves and no text selection starts.
        event.preventDefault()

        if (event.target === thumb) {
          track.setPointerCapture(event.pointerId)
          drag = {
            axis,
            pointer: along(event),
            pointerId: event.pointerId,
            scroll: vertical ? viewport.scrollTop : viewport.scrollLeft,
            scrollPerPixel: scrollPerThumbPixel(
              axis.scrollSize,
              axis.clientSize,
              axis.trackSize,
              axis.thumbSize,
            ),
          }
          return
        }

        const trackRect = track.getBoundingClientRect()
        const pressed = along(event) - (vertical ? trackRect.top : trackRect.left)
        const step = (pressed < axis.thumbOffset ? -1 : 1) * axis.clientSize * PAGE_STEP

        viewport.scrollBy(vertical ? { top: step } : { left: step })
      }
      const onPointerMove = (event: PointerEvent) => {
        if (drag?.axis === axis && event.pointerId === drag.pointerId) {
          scrollAlong(axis, drag.scroll + (along(event) - drag.pointer) * drag.scrollPerPixel)
        }
      }
      const endDrag = (event: PointerEvent) => {
        if (drag?.axis !== axis || event.pointerId !== drag.pointerId) {
          return
        }

        drag = null

        // Let go off the bar: the leave was held back while it was captured.
        if (hovered !== axis) {
          delete track.dataset.expanded
        }

        hideLater()
      }
      const onPointerEnter = () => {
        hovered = axis
        track.dataset.expanded = ""
        show()
      }
      const onPointerLeave = () => {
        if (hovered === axis) {
          hovered = null
        }

        if (drag?.axis !== axis) {
          delete track.dataset.expanded
        }

        hideLater()
      }
      // A wheel over a bar belongs to the box beneath: the bar is no part of it,
      // so the WebView would zoom the app on a ctrl-wheel or scroll nothing.
      const onWheel = (event: WheelEvent) => {
        event.preventDefault()

        // The event doubles as its own init dictionary. The box's own handlers
        // have their say first: the viewer zooms on a ctrl-wheel.
        if (!viewport.dispatchEvent(new WheelEvent("wheel", event)) || event.ctrlKey) {
          return
        }

        let left = normalizeWheelDelta(event.deltaX, event.deltaMode)
        let top = normalizeWheelDelta(event.deltaY, event.deltaMode)

        // A shifted wheel scrolls sideways where the engine has not already
        // turned it.
        if (event.shiftKey && left === 0) {
          left = top
          top = 0
        }

        // Programmatic scrolls move `overflow: hidden` too: the tab strip's
        // clipped 1px would shift its tabs.
        viewport.scrollBy({ left: x.scrolls ? left : 0, top: y.scrolls ? top : 0 })
      }

      // Pointerdown's default alone leaves the press free to start a selection.
      const onMouseDown = (event: MouseEvent) => event.preventDefault()

      const entries = [
        ["pointerdown", onPointerDown],
        ["pointermove", onPointerMove],
        ["pointerup", endDrag],
        ["pointercancel", endDrag],
        ["lostpointercapture", endDrag],
        ["pointerenter", onPointerEnter],
        ["pointerleave", onPointerLeave],
      ] as const

      for (const [type, listener] of entries) {
        track.addEventListener(type, listener)
      }

      track.addEventListener("mousedown", onMouseDown)
      track.addEventListener("wheel", onWheel, { passive: false })

      return () => {
        for (const [type, listener] of entries) {
          track.removeEventListener(type, listener)
        }

        track.removeEventListener("mousedown", onMouseDown)
        track.removeEventListener("wheel", onWheel)
      }
    })

    // The content's size is its children's: watch each, as they come and go.
    // Observing reports the new child's size, which places the bars from there.
    const resizeObserver = new ResizeObserver(() => place())
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            resizeObserver.observe(node)
          }
        }

        for (const node of record.removedNodes) {
          if (node instanceof Element) {
            resizeObserver.unobserve(node)
          }
        }
      }
    })

    resizeObserver.observe(viewport)
    resizeObserver.observe(root)

    for (const child of viewport.children) {
      resizeObserver.observe(child)
    }

    mutationObserver.observe(viewport, { childList: true })
    viewport.addEventListener("scroll", onScroll, { passive: true })
    place()

    return () => {
      viewport.removeEventListener("scroll", onScroll)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      clearTimeout(hideTimer)
      // The bars outlive a re-run onto another box, as when Settings switches
      // panels; with the timer gone, nothing else would hide them.
      delete root.dataset.visible
      delete yTrack.dataset.expanded
      delete xTrack.dataset.expanded

      for (const removeListeners of listeners) {
        removeListeners()
      }
    }
  }, [thin, viewportRef])

  // The thumbs' ring is for the viewer, where they cross paper that stays white
  // in a dark theme too: a light thumb would vanish on it without a dark edge.
  // They keep 4px off the edge, clear of the 5px a borderless window claims on
  // Linux for resizing: a bar at the window's edge stays grabbable.
  const thumbClass =
    "absolute rounded-full bg-foreground/40 ring-1 ring-background/40 group-data-expanded/track:bg-foreground/60"
  const trackClass =
    "group/track pointer-events-auto absolute cursor-default touch-none transition-colors data-expanded:bg-foreground/5"

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-500 data-visible:opacity-100 data-visible:duration-100",
        className,
      )}
      data-slot="overlay-scrollbars"
      ref={rootRef}
    >
      <div
        className={cn(trackClass, "top-0 right-0 bottom-0", thin ? "w-1.5" : "w-3")}
        data-axis="y"
        ref={yTrackRef}
      >
        <div
          className={cn(
            thumbClass,
            "top-0 transition-[width,background-color]",
            thin ? "right-px w-1" : "right-1 w-1.5 group-data-expanded/track:w-2",
          )}
          ref={yThumbRef}
        />
      </div>
      <div
        className={cn(trackClass, "right-0 bottom-0 left-0", thin ? "h-1.5" : "h-3")}
        data-axis="x"
        ref={xTrackRef}
      >
        <div
          className={cn(
            thumbClass,
            "left-0 transition-[height,background-color]",
            thin ? "bottom-px h-1" : "bottom-1 h-1.5 group-data-expanded/track:h-2",
          )}
          ref={xThumbRef}
        />
      </div>
    </div>
  )
}
