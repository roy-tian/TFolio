import { describe, expect, it } from "bun:test"

import { registerTextPage, textPage, textPageAtPoint, textPageLayout } from "@/lib/textSelectionPage"

const rects = [{ left: 0, top: 0, width: 40, height: 10 }]

function surface() {
  let measurements = 0
  const page = {
    getBoundingClientRect() {
      measurements++
      return { left: 0, top: 0, right: 100, bottom: 100 }
    },
  } as Element
  const viewer = {
    contains: (element: Element) => element === page,
    ownerDocument: { elementFromPoint: () => null },
    querySelectorAll: () => { throw new Error("must not scan virtualized page wrappers") },
  } as unknown as HTMLElement
  const layer = {
    closest: (selector: string) => selector === "[data-page-number]" ? page : viewer,
    querySelectorAll: () => [],
  } as unknown as HTMLElement
  return { page, viewer, layer, measurements: () => measurements }
}

describe("mounted text page geometry", () => {
  it("shares one immutable layout across repeated hit tests and painting lookups", () => {
    const { page, viewer, layer } = surface()
    const layout = textPageLayout(rects)
    const release = registerTextPage(layer, rects)!
    try {
      for (let index = 0; index < 100; index++) {
        expect(textPage(page)?.layout).toBe(layout)
        expect(textPageAtPoint(viewer, 5, 5)?.layout).toBe(layout)
        expect(textPage(page)?.layout.lineOfRun.get(0)).toBe(layout.lines[0])
      }
    } finally {
      release()
    }
    expect(textPage(page)).toBeUndefined()
    expect(textPageAtPoint(viewer, 5, 5)).toBeUndefined()
  })

  it("builds no layout until a selection or drag first reads it", () => {
    const { page, layer } = surface()
    let reads = 0
    const counted = [{
      get left() { reads++; return 0 },
      get top() { reads++; return 0 },
      width: 40,
      height: 10,
    }]
    const release = registerTextPage(layer, counted)!
    try {
      expect(reads).toBe(0)
      expect(textPage(page)?.layout.lines).toHaveLength(1)
      expect(reads).toBeGreaterThan(0)
    } finally {
      release()
    }
  })

  it("replaces geometry with the text layer and cannot erase a replacement on late cleanup", () => {
    const { page, viewer, layer } = surface()
    const releaseOld = registerTextPage(layer, rects)!
    const next = [{ ...rects[0], top: 30 }]
    const releaseNext = registerTextPage(layer, next)!
    releaseOld()
    expect(textPage(page)?.layout).toBe(textPageLayout(next))
    expect(textPageAtPoint(viewer, 5, 5)?.layout).toBe(textPageLayout(next))
    releaseNext()
    expect(textPageAtPoint(viewer, 5, 5)).toBeUndefined()
  })

  it("does not measure mounted pages when the native hit already names the page", () => {
    const { page, viewer, layer, measurements } = surface()
    viewer.ownerDocument.elementFromPoint = () => ({ closest: () => page }) as unknown as Element
    const release = registerTextPage(layer, rects)!
    expect(textPageAtPoint(viewer, 5, 5)?.element).toBe(page)
    expect(measurements()).toBe(0)
    release()
  })
})
