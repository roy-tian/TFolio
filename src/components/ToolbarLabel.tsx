import { useLayoutEffect, type ReactNode, type RefObject } from "react"

const LABEL_SELECTOR = "[data-slot=toolbar-label]"
const FOLDED = "data-labels-folded"

// Folded, the bar unfolds only with this much to spare: whole-pixel widths
// measured in either state can disagree by a pixel or two, which would
// otherwise fold and unfold it every frame at the edge.
const UNFOLD_SLACK = 4

/** Words beside a title-bar icon, folded away while the bar is too narrow
    for every label: the icon's tooltip still names it. The inner box keeps
    its full width while folded, so the bar can tell what unfolding would take. */
export function ToolbarLabel({ children }: { children: ReactNode }) {
  return (
    <span className="overflow-hidden in-data-labels-folded:max-w-0" data-slot="toolbar-label">
      <span className="block w-max pr-[5px] pl-1.5">{children}</span>
    </span>
  )
}

/** The width the bar needs with every label showing, folded or not. */
function widthWithLabels(bar: HTMLElement) {
  const style = getComputedStyle(bar)
  const parts = [...bar.children] as HTMLElement[]
  let width =
    parseFloat(style.paddingLeft) +
    parseFloat(style.paddingRight) +
    parseFloat(style.columnGap) * Math.max(0, parts.length - 1)

  for (const part of parts) {
    width += part.scrollWidth
  }

  for (const label of bar.querySelectorAll<HTMLElement>(LABEL_SELECTOR)) {
    width += label.scrollWidth - label.clientWidth
  }

  return width
}

/** Folds the bar's labels (`ToolbarLabel`) while it cannot hold them, measured
    rather than set at a width: each language's words take different room. */
export function useFoldingLabels(barRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const bar = barRef.current

    if (!bar) {
      return
    }

    const observer = new ResizeObserver(() => {
      const slack = bar.hasAttribute(FOLDED) ? UNFOLD_SLACK : 0

      bar.toggleAttribute(FOLDED, widthWithLabels(bar) + slack > bar.clientWidth)
      watch()
    })

    // The bar's own width, what its parts hold, and each label's words: a
    // late font changes a folded label's width without moving anything else.
    const watch = () => {
      for (const element of [bar, ...bar.children, ...bar.querySelectorAll(`${LABEL_SELECTOR} > *`)]) {
        observer.observe(element)
      }
    }

    watch()

    return () => observer.disconnect()
  }, [barRef])
}
