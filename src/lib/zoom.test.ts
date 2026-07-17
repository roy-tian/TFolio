import { describe, expect, test } from "bun:test"

import { MAX_PAGE_WIDTH, type PdfPageInfo } from "./pdf"
import {
  applyWheelZoom,
  autoScale,
  bookColumnWidth,
  BOOK_GAP,
  clampZoom,
  fitHeightScale,
  fitWidthScale,
  isFitActive,
  MAX_ZOOM,
  MIN_ZOOM,
  nextFitMode,
  normalizeWheelDelta,
  POINT_TO_PX,
  referenceDimensions,
  resolveZoomScale,
  stepZoomPercent,
  zoomToPercent,
} from "./zoom"

// A stock A4 page, in PDF points.
const a4: PdfPageInfo = { height: 842, rotation: 0, width: 595 }
const page = (width: number, height: number): PdfPageInfo => ({
  height,
  rotation: 0,
  width,
})
// Reference dimensions come back in CSS pixels, so the points a page declares
// have to be converted before they can be compared against.
const px = (points: number) => points * POINT_TO_PX

describe("clampZoom", () => {
  test("holds a scale inside the supported range", () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
    expect(clampZoom(99)).toBe(MAX_ZOOM)
  })
})

describe("zoomToPercent", () => {
  test("reports whole percentages", () => {
    expect(zoomToPercent(1)).toBe(100)
    expect(zoomToPercent(1.3746)).toBe(137)
  })
})

describe("POINT_TO_PX", () => {
  // What 100% means, and the one figure another reader can be checked against:
  // A4 is 210mm — 8.27in — across, which is 794 pixels at the 96 DPI CSS
  // assumes. A point-for-pixel scale would render it 595 and be a quarter short.
  test("puts a page at its paper size at 100%", () => {
    expect(Math.round(595.276 * POINT_TO_PX)).toBe(794)
    // US Letter, 8.5in across.
    expect(Math.round(612 * POINT_TO_PX)).toBe(816)
  })
})

describe("referenceDimensions", () => {
  test("is exact for the ordinary uniform document", () => {
    expect(referenceDimensions([a4, a4, a4], 0)).toEqual({
      referenceHeight: px(842),
      referenceWidth: px(595),
      widestWidth: px(595),
    })
  })

  // The case this exists for: a handful of landscape pages among the portrait
  // ones must not shrink every portrait page to fit them.
  test("ignores an outlier page size", () => {
    const pages = [
      ...Array.from({ length: 35 }, () => page(595, 842)),
      ...Array.from({ length: 3 }, () => page(842, 595)),
    ]

    expect(referenceDimensions(pages, 0)).toEqual({
      referenceHeight: px(842),
      referenceWidth: px(595),
      widestWidth: px(842),
    })
  })

  test("takes the larger page when a document is split evenly", () => {
    expect(referenceDimensions([page(595, 842), page(300, 400)], 0)).toEqual({
      referenceHeight: px(842),
      referenceWidth: px(595),
      widestWidth: px(595),
    })
  })

  // Rotating the document swaps what a page spans, so a fit has to follow it.
  test("applies the user rotation", () => {
    expect(referenceDimensions([a4], 90)).toEqual({
      referenceHeight: px(595),
      referenceWidth: px(842),
      widestWidth: px(842),
    })
    expect(referenceDimensions([a4], 180)).toEqual({
      referenceHeight: px(842),
      referenceWidth: px(595),
      widestWidth: px(595),
    })
    expect(referenceDimensions([a4], 270)).toEqual({
      referenceHeight: px(595),
      referenceWidth: px(842),
      widestWidth: px(842),
    })
  })

  test("survives a document with no pages", () => {
    expect(referenceDimensions([], 0)).toEqual({
      referenceHeight: 0,
      referenceWidth: 0,
      widestWidth: 0,
    })
  })
})

describe("bookColumnWidth", () => {
  test("splits the column, less the gap between the pages", () => {
    expect(bookColumnWidth(1000)).toBe((1000 - BOOK_GAP) / 2)
  })

  // A half pixel here is rounded up into each page's width later, which puts the
  // spread a pixel wider than the column it has to sit in.
  test("leaves a whole number of pixels, so a spread cannot overflow", () => {
    expect(bookColumnWidth(1035)).toBe(507)
    expect(bookColumnWidth(1035) * 2 + BOOK_GAP).toBeLessThanOrEqual(1035)
  })

  test("never goes negative on a column narrower than the gap", () => {
    expect(bookColumnWidth(0)).toBe(0)
  })
})

describe("autoScale", () => {
  // The sizing a uniform document has always opened at, now spelled as a scale.
  test("fills a narrow column", () => {
    expect(autoScale(500, 595, 595)).toBeCloseTo(500 / 595)
  })

  test("stops widening a page at MAX_PAGE_WIDTH", () => {
    expect(autoScale(1856, 595, 595)).toBeCloseTo(MAX_PAGE_WIDTH / 595)
  })

  // Otherwise the odd landscape page would spill out of the column and the
  // document would open already needing to be scrolled sideways.
  test("holds back so the widest page still fits", () => {
    expect(autoScale(1036, 595, 842)).toBeCloseTo(1036 / 842)
  })

  test("ignores the widest page once it fits anyway", () => {
    expect(autoScale(3000, 595, 842)).toBeCloseTo(MAX_PAGE_WIDTH / 595)
  })

  test("falls back to actual size before a document is measured", () => {
    expect(autoScale(1000, 0, 0)).toBe(1)
  })
})

describe("fitWidthScale", () => {
  // Unlike autoScale, an explicit fit-width means all of the width.
  test("uses the whole column, past MAX_PAGE_WIDTH", () => {
    expect(fitWidthScale(1856, 595)).toBeCloseTo(1856 / 595)
  })

  test("falls back to actual size before a document is measured", () => {
    expect(fitWidthScale(1000, 0)).toBe(1)
  })

  test("stays inside the supported range", () => {
    expect(fitWidthScale(100000, 595)).toBe(MAX_ZOOM)
  })
})

describe("fitHeightScale", () => {
  test("fits the tallest page to the viewport", () => {
    expect(fitHeightScale(800, 842)).toBeCloseTo(800 / 842)
  })

  test("falls back to actual size before a document is measured", () => {
    expect(fitHeightScale(800, 0)).toBe(1)
  })
})

describe("resolveZoomScale", () => {
  const fits = { auto: 1.5, fitHeight: 0.95, fitWidth: 3.1 }

  test("reads the scale its mode names", () => {
    expect(resolveZoomScale({ customScale: 2, mode: "auto" }, fits)).toBe(1.5)
    expect(resolveZoomScale({ customScale: 2, mode: "fit-width" }, fits)).toBe(3.1)
    expect(resolveZoomScale({ customScale: 2, mode: "fit-height" }, fits)).toBe(0.95)
    expect(resolveZoomScale({ customScale: 2, mode: "custom" }, fits)).toBe(2)
  })

  test("clamps whatever it is handed", () => {
    expect(resolveZoomScale({ customScale: 50, mode: "custom" }, fits)).toBe(MAX_ZOOM)
  })
})

describe("stepZoomPercent", () => {
  test("moves to the next rung up or down", () => {
    expect(stepZoomPercent(100, 1)).toBe(125)
    expect(stepZoomPercent(100, -1)).toBe(75)
  })

  // The point of stepping from the live percent: a fit lands between rungs.
  test("steps to the neighbouring rung from between two", () => {
    expect(stepZoomPercent(137, 1)).toBe(150)
    expect(stepZoomPercent(137, -1)).toBe(125)
  })

  test("clamps at the ends instead of wrapping", () => {
    expect(stepZoomPercent(800, 1)).toBe(800)
    expect(stepZoomPercent(25, -1)).toBe(25)
    expect(stepZoomPercent(2000, 1)).toBe(800)
    expect(stepZoomPercent(5, -1)).toBe(25)
  })

  test("returns to the ladder from a zoom above or below it", () => {
    expect(stepZoomPercent(2000, -1)).toBe(800)
    expect(stepZoomPercent(5, 1)).toBe(25)
  })
})

describe("normalizeWheelDelta", () => {
  test("passes pixel deltas straight through", () => {
    expect(normalizeWheelDelta(100, 0)).toBe(100)
  })

  test("scales the line and page modes to roughly a notch", () => {
    expect(normalizeWheelDelta(3, 1)).toBe(48)
    expect(normalizeWheelDelta(1, 2)).toBe(400)
  })
})

describe("applyWheelZoom", () => {
  // Sign convention: a wheel scrolled up reports a negative delta, and zooms in.
  test("zooms in on a negative delta and out on a positive one", () => {
    expect(applyWheelZoom(1, -100)).toBeGreaterThan(1)
    expect(applyWheelZoom(1, 100)).toBeLessThan(1)
  })

  test("moves in proportional steps, so a notch feels the same at any zoom", () => {
    const fromOne = applyWheelZoom(1, -100) / 1
    const fromThree = applyWheelZoom(3, -100) / 3

    expect(fromOne).toBeCloseTo(fromThree)
  })

  test("stays inside the supported range", () => {
    expect(applyWheelZoom(MAX_ZOOM, -10000)).toBe(MAX_ZOOM)
    expect(applyWheelZoom(MIN_ZOOM, 10000)).toBe(MIN_ZOOM)
  })
})

describe("nextFitMode", () => {
  test("toggles out of fit-width and into it from anywhere else", () => {
    expect(nextFitMode("fit-width")).toBe("fit-height")
    expect(nextFitMode("fit-height")).toBe("fit-width")
    expect(nextFitMode("custom")).toBe("fit-width")
    expect(nextFitMode("auto")).toBe("fit-width")
  })
})

describe("isFitActive", () => {
  // `auto` is the opening sizing, not a fit the reader chose, so it reads as off.
  test("counts only the two fit modes", () => {
    expect(isFitActive("fit-width")).toBe(true)
    expect(isFitActive("fit-height")).toBe(true)
    expect(isFitActive("auto")).toBe(false)
    expect(isFitActive("custom")).toBe(false)
  })
})
