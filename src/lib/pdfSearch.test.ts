import { describe, expect, it } from "bun:test"

import {
  firstSearchMatchFromPage,
  searchMatchBox,
  searchRevealOffset,
  stepSearchMatch,
} from "@/lib/pdfSearch"

const match = (pageNumber: number) => ({ pageNumber, rects: [] })

describe("PDF search navigation", () => {
  it("starts at the first occurrence at or after the page being read", () => {
    const matches = [match(1), match(3), match(3), match(8)]

    expect(firstSearchMatchFromPage(matches, 3)).toBe(1)
    expect(firstSearchMatchFromPage(matches, 4)).toBe(3)
    expect(firstSearchMatchFromPage(matches, 9)).toBe(0)
    expect(firstSearchMatchFromPage([], 1)).toBeNull()
  })

  it("steps in either direction and wraps", () => {
    expect(stepSearchMatch(0, 3, -1)).toBe(2)
    expect(stepSearchMatch(2, 3, 1)).toBe(0)
    expect(stepSearchMatch(null, 3, 1)).toBe(0)
    expect(stepSearchMatch(null, 3, -1)).toBe(2)
    expect(stepSearchMatch(0, 0, 1)).toBeNull()
  })
})

const box = (top: number, bottom: number, left = 0, right = 100) => ({
  bottom,
  left,
  right,
  top,
})

const viewport = box(0, 500, 0, 400)

describe("revealing the active occurrence", () => {
  it("covers every rectangle of a result broken over two lines", () => {
    expect(searchMatchBox([box(10, 20, 60, 100), box(30, 40, 0, 25)])).toEqual({
      bottom: 40,
      left: 0,
      right: 100,
      top: 10,
    })
    expect(searchMatchBox([])).toBeNull()
  })

  it("stays put for a result already on screen", () => {
    expect(searchRevealOffset([box(100, 120)], viewport)).toBeNull()
    // Clipped by a fraction of a pixel, which page geometry is full of.
    expect(searchRevealOffset([box(-0.2, 120)], viewport)).toBeNull()
    expect(searchRevealOffset([box(-0.51, 120)], viewport)).toEqual({
      left: 0, top: -190.255,
    })
    // Zoomed in past the viewport, and covering it: no scroll shows more.
    expect(searchRevealOffset([box(-50, 800, -10, 500)], viewport)).toBeNull()
  })

  it("centres only the axis that clips the result", () => {
    expect(searchRevealOffset([box(700, 740)], viewport)).toEqual({
      left: 0,
      top: 470,
    })
    expect(searchRevealOffset([box(100, 140, 600, 700)], viewport)).toEqual({
      left: 450,
      top: 0,
    })
    expect(searchRevealOffset([box(-100, -60)], viewport)).toEqual({
      left: 0,
      top: -330,
    })
  })

  it("reveals a real segment when a wrapped result's empty union spans the viewport", () => {
    const view = box(84, 760, 0, 1100)
    const rects = [box(230, 329, 1177, 1602), box(390, 489, -898, -583)]

    expect(searchRevealOffset(rects, view)).toEqual({ left: 839.5, top: 0 })
    expect(searchRevealOffset([], view)).toBeNull()
    // A later visible segment is sufficient when the whole phrase cannot fit.
    expect(searchRevealOffset([...rects, box(390, 489, 100, 400)], view)).toBeNull()
  })

  it.each([
    ["cannot move out from under the bar", box(116, 126, 800, 900)],
    ["moves but remains under the bar", box(116, 126, 1800, 1900)],
    ["moves but remains offscreen", box(146, 156, 2300, 2400)],
  ] as const)("reveals a reachable wrapped segment when the first %s", (_, first) => {
    const view = box(84, 760, 0, 1100)
    const findBar = box(88, 128, 732, 1084)
    const reachable = box(146, 156, -600, -500)
    const bounds = { minLeft: -1000, maxLeft: 1000, minTop: 0, maxTop: 2000 }

    expect(searchRevealOffset([first, reachable], view, findBar, bounds)).toEqual({
      left: -1000, top: 0,
    })
    // At that destination the second segment is on screen and clear of the bar.
    expect(searchRevealOffset([box(146, 156, 400, 500)], view, findBar, bounds)).toBeNull()
  })

  it("reveals all wrapped segments when their union fits", () => {
    expect(searchRevealOffset([
      box(460, 480, 60, 100), box(510, 530, 0, 25),
    ], viewport)).toEqual({ left: 0, top: 245 })
  })

  it("avoids the find bar at the final horizontal position", () => {
    const view = box(84, 760, 0, 1100)
    const findBar = box(88, 128, 732, 1084)
    const rects = [box(94, 158, -900, -100)]

    expect(searchRevealOffset(rects, view, findBar)).toEqual({
      left: -1050, top: -296,
    })
    // Clamping can keep the result beside the bar rather than underneath it.
    expect(searchRevealOffset(rects, view, findBar, {
      minLeft: -800, maxLeft: 0, minTop: -500, maxTop: 500,
    })).toEqual({ left: -800, top: 0 })
    // Clamping can also leave a result under a bar that centering would clear.
    expect(searchRevealOffset([box(94, 158, 1200, 1300)], view, findBar, {
      minLeft: 0, maxLeft: 400, minTop: -500, maxTop: 500,
    })).toEqual({ left: 400, top: -296 })
    // The requested vertical adjustment must also respect the scroll limits.
    expect(searchRevealOffset(rects, view, findBar, {
      minLeft: -1200, maxLeft: 0, minTop: -100, maxTop: 500,
    })).toEqual({ left: -1050, top: -100 })
  })

  it("does not avoid a bar the proposed scroll already clears", () => {
    expect(searchRevealOffset([box(10, 30, 600, 700)], viewport,
      box(0, 40, 250, 650),
    )).toEqual({ left: 450, top: 0 })
  })

  it("moves a result out from under the find bar", () => {
    const findBar = box(0, 40, 250, 400)

    expect(searchRevealOffset([box(10, 30, 260, 320)], viewport, findBar)).toEqual(
      { left: 0, top: -230 },
    )
    // Beside the bar, not under it.
    expect(searchRevealOffset([box(10, 30, 0, 100)], viewport, findBar)).toBeNull()
  })
})
