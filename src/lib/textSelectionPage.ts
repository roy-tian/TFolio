import type { PagePointsRect } from "@/lib/annotationGeometry"
import { textLines, type TextLine } from "@/lib/textSelectionLayout"

export type TextPageLayout = {
  rects: PagePointsRect[]
  lines: TextLine[]
  lineOfRun: Map<number, TextLine>
}

const layouts = new WeakMap<PagePointsRect[], TextPageLayout>()

/** Built on first use, not on mount: scrolling mounts pages nobody selects on.
    Kept with the runs array, which cached page text hands back on remount. */
export function textPageLayout(rects: PagePointsRect[]) {
  let layout = layouts.get(rects)
  if (!layout) {
    const lines = textLines(rects)
    const lineOfRun = new Map(lines.flatMap(line => line.runs.map(index => [index, line] as const)))
    layout = { rects, lines, lineOfRun }
    layouts.set(rects, layout)
  }
  return layout
}

export type MountedTextPage = {
  element: Element
  layer: HTMLElement
  spans: HTMLElement[]
  readonly layout: TextPageLayout
}

const byPage = new WeakMap<Element, MountedTextPage>()
const byViewer = new WeakMap<Element, Set<MountedTextPage>>()

/** Registration follows React's text/geometry lifetime, not the selection's.
    Raw page coordinates survive zoom, scroll and rotation without measuring
    every DOM run again. Unmounting releases the nodes; the layout lives as
    long as its runs array. */
export function registerTextPage(layer: HTMLElement, rects: PagePointsRect[]) {
  const element = layer.closest("[data-page-number]")
  const viewer = layer.closest("[data-pdf-scroll-root]")
  if (!element || !viewer) return

  const mounted: MountedTextPage = {
    element,
    layer,
    spans: [...layer.querySelectorAll<HTMLElement>("span")],
    get layout() {
      return textPageLayout(rects)
    },
  }
  let pages = byViewer.get(viewer)
  if (!pages) {
    pages = new Set()
    byViewer.set(viewer, pages)
  }
  pages.add(mounted)
  byPage.set(element, mounted)
  return () => {
    pages.delete(mounted)
    if (byPage.get(element) === mounted) byPage.delete(element)
  }
}

export function textPage(element: Element) {
  return byPage.get(element)
}

/** Normal movement is one native element hit, independent of document length.
    In margins/outside the viewport only mounted text surfaces are candidates;
    virtualized page wrappers never enter this registry. */
export function textPageAtPoint(viewer: HTMLElement, x: number, y: number) {
  const hit = viewer.ownerDocument.elementFromPoint(x, y)?.closest("[data-page-number]")
  if (hit && viewer.contains(hit)) {
    const page = byPage.get(hit)
    if (page) return page
  }
  let best: MountedTextPage | undefined
  let distance = Infinity
  for (const page of byViewer.get(viewer) ?? []) {
    const box = page.element.getBoundingClientRect()
    const dx = Math.max(box.left - x, x - box.right, 0)
    const dy = Math.max(box.top - y, y - box.bottom, 0)
    const next = dx * dx + dy * dy
    if (next < distance) {
      distance = next
      best = page
    }
  }
  return best
}
