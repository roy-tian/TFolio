import { useLayoutEffect, useRef, type RefObject } from "react"

/** A cell of the flow by its `data-flip-key`, and how far below the view's top
    it stands. */
type Anchor = { key: string; offset: number }

/** The flow's own cells: a cell fading out has given up its key. */
const cellsOf = (flow: HTMLElement) =>
  [...flow.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.flipKey !== undefined,
  )

/** Offsets as laid out, since a slide's transform moves no cell's place. A
    cell counts as shown with half of it in view: one only peeking in from
    the edge, kept there, would put its row out of sight. */
function anchorIn(view: HTMLElement, flow: HTMLElement, preferred: Element | null): Anchor | null {
  if (view.getClientRects().length === 0) {
    return null
  }

  const box = view.getBoundingClientRect()
  const origin = flow.getBoundingClientRect().top
  const shows = (cell: HTMLElement) => {
    const top = origin + cell.offsetTop
    const seen = Math.min(top + cell.offsetHeight, box.bottom) - Math.max(top, box.top)

    return seen > 0 && seen >= Math.min(cell.offsetHeight, box.height) / 2
  }
  let own = preferred

  while (own && own.parentElement !== flow) {
    own = own.parentElement
  }

  const cell =
    own instanceof HTMLElement && own.dataset.flipKey !== undefined && shows(own)
      ? own
      : cellsOf(flow).find(shows)

  return cell ? { key: cell.dataset.flipKey!, offset: origin + cell.offsetTop - box.top } : null
}

/**
 * Keeps one cell of the flow where it stood in the scrolled `view` as a change
 * of `layout` reflows it: `preferred` while it shows, else the first cell that
 * shows. The flow must be its cells' offset parent, and keys them as
 * `useFlipLayout` does.
 */
export function useReflowAnchor(
  viewRef: RefObject<HTMLElement | null>,
  flowRef: RefObject<HTMLElement | null>,
  /** What the flow is laid out by; compared by identity. */
  layout: unknown,
  preferred: () => Element | null,
) {
  const laidOutRef = useRef(layout)
  const anchorRef = useRef<Anchor | null>(null)

  // Read in render, while the layout the commit replaces still stands. Every
  // render of a new layout reads again, so a stale anchor is never applied.
  if (layout !== laidOutRef.current && viewRef.current && flowRef.current) {
    anchorRef.current = anchorIn(viewRef.current, flowRef.current, preferred())
  }

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const view = viewRef.current
    const flow = flowRef.current

    anchorRef.current = null
    laidOutRef.current = layout

    if (!anchor || !view || !flow) {
      return
    }

    const cell = cellsOf(flow).find((each) => each.dataset.flipKey === anchor.key)

    if (!cell) {
      return
    }

    const top = flow.getBoundingClientRect().top + cell.offsetTop - view.getBoundingClientRect().top

    view.scrollBy({ behavior: "instant", top: top - anchor.offset })
  }, [flowRef, layout, viewRef])
}
