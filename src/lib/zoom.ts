import { dimensionsForRotation, MAX_PAGE_WIDTH, type PdfPageInfo } from "@/lib/pdf"

// `auto` is the sizing a document opens with and is not one of the modes the fit
// button cycles through: the reader never picks it, they only ever leave it.
export type ZoomMode = "auto" | "custom" | "fit-height" | "fit-width"

export type ZoomState = {
  // Only read in "custom" mode, but kept across a stint in a fit mode so that
  // returning to an explicit zoom resumes where the reader left it.
  customScale: number
  mode: ZoomMode
}

export type FitScales = {
  auto: number
  fitHeight: number
  fitWidth: number
}

/**
 * CSS pixels one PDF point covers at 100%.
 *
 * A PDF point is 1/72 inch and a CSS pixel is 1/96, so actual size is 4/3 of a
 * point rather than one-for-one: a stock A4 page is 794px wide at 100%, not
 * 595. Treating the two as equal would leave every page a quarter under the
 * size the same document opens at in any other reader, and report a zoom a
 * third higher than that reader would for the same picture.
 */
export const POINT_TO_PX = 96 / 72

// A scale of 1 is actual size: the page measures what it would on paper, on a
// display of the 96 DPI that CSS assumes.
export const MIN_ZOOM = 0.25
// Past this a re-render stops buying detail: the render width saturates at
// MAX_RENDER_WIDTH and the page only gets softer.
export const MAX_ZOOM = 8

/** Rungs `+`/`-` land on, in percent. The ends match MIN_ZOOM and MAX_ZOOM. */
export const zoomSteps = [
  25, 50, 75, 100, 125, 150, 200, 300, 400, 600, 800,
] as const

export const defaultZoomState: ZoomState = { customScale: 1, mode: "auto" }

/** Padding of the scrolling column: `px-8` on either side, `py-8` on both ends. */
export const CONTENT_PADDING_X = 64
export const CONTENT_PADDING_Y = 64

// Space between the two pages of a spread. Applied inline rather than as a
// Tailwind class because the column arithmetic has to agree with it.
export const BOOK_GAP = 20

export function clampZoom(scale: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
}

export function zoomToPercent(scale: number) {
  return Math.round(scale * 100)
}

/**
 * The page size the document is mostly made of, in CSS pixels at 100% and with
 * the user's rotation applied. Every scale is worked out against it.
 *
 * A fit has to resolve to one scale for the whole document, because a zoom is
 * one number and pages of different sizes have to keep their sizes relative to
 * each other. So a fit needs one page to measure, and the one the document is
 * mostly made of is the one the reader is almost always looking at.
 *
 * Measuring the *widest* page instead is the tempting choice, since nothing
 * could then overflow. But one landscape page among thirty-five portrait ones
 * is enough to hold every portrait page at 71% of the width it asked for —
 * including under fit-width, which would then visibly not fit the width. A rare
 * page overflowing into a horizontal scroll is the better failure: it is what
 * the reader asked for, and it is confined to the odd page out.
 *
 * For the ordinary document, where every page is the same size, there is no odd
 * page out and this is exactly that size.
 */
export function referenceDimensions(pages: PdfPageInfo[], rotation: number) {
  const counts = new Map<
    string,
    { count: number; height: number; width: number }
  >()

  for (const page of pages) {
    // Converted here, at the one boundary where a PDF's own units become a size
    // on screen, so that every scale downstream is a plain pixels-over-pixels
    // ratio.
    const { height, width } = dimensionsForRotation(
      rotation,
      page.width * POINT_TO_PX,
      page.height * POINT_TO_PX,
    )
    const key = `${width}x${height}`
    const seen = counts.get(key)

    if (seen) {
      seen.count += 1
    } else {
      counts.set(key, { count: 1, height, width })
    }
  }

  let referenceHeight = 0
  let referenceWidth = 0
  let widestWidth = 0
  let bestCount = 0

  for (const { count, height, width } of counts.values()) {
    widestWidth = Math.max(widestWidth, width)

    // A document split evenly between two sizes takes the larger, so that the
    // half that does not drive the fit is the half that stays inside it.
    const isBetter =
      count > bestCount ||
      (count === bestCount && width * height > referenceWidth * referenceHeight)

    if (isBetter) {
      bestCount = count
      referenceHeight = height
      referenceWidth = width
    }
  }

  return { referenceHeight, referenceWidth, widestWidth }
}

/**
 * Width one page of a spread may take up, once the gap between them is out.
 *
 * Rounded down, because the two columns and the gap have to add back up to no
 * more than the column: an odd width left as a half pixel gets rounded up on
 * the way to a page's own width, and the spread lands a pixel over and takes a
 * scrollbar with it.
 */
export function bookColumnWidth(contentWidth: number) {
  return Math.max(0, Math.floor((contentWidth - BOOK_GAP) / 2))
}

/**
 * What a freshly opened document gets: as large as the usual page can be without
 * passing MAX_PAGE_WIDTH, so it keeps a readable measure on a wide monitor
 * instead of stretching the full window — and never so large that the widest
 * page spills out of the column, because a document should not open needing to
 * be scrolled sideways.
 *
 * That second bound is only ever reached by a document with an odd page out, and
 * it is the reason this is not simply what the fit-width button does. Someone
 * pressing fit-width has asked for all of the width and can have the sideways
 * scroll that comes with it; nobody asks for it by opening a file.
 */
export function autoScale(
  availableWidth: number,
  referenceWidth: number,
  widestWidth: number,
) {
  if (referenceWidth <= 0) {
    return 1
  }

  const readable = MAX_PAGE_WIDTH / referenceWidth
  const withoutOverflow =
    widestWidth > 0 ? availableWidth / widestWidth : readable

  return clampZoom(Math.min(readable, withoutOverflow))
}

export function fitWidthScale(availableWidth: number, referenceWidth: number) {
  if (referenceWidth <= 0) {
    return 1
  }

  return clampZoom(availableWidth / referenceWidth)
}

export function fitHeightScale(
  availableHeight: number,
  referenceHeight: number,
) {
  if (referenceHeight <= 0) {
    return 1
  }

  return clampZoom(availableHeight / referenceHeight)
}

export function resolveZoomScale(zoom: ZoomState, fits: FitScales) {
  const scale =
    zoom.mode === "auto"
      ? fits.auto
      : zoom.mode === "fit-width"
        ? fits.fitWidth
        : zoom.mode === "fit-height"
          ? fits.fitHeight
          : zoom.customScale

  return clampZoom(scale)
}

/**
 * The rung strictly above (`1`) or below (`-1`) `percent`, or the ladder's own
 * end when there is none.
 *
 * Stepping from the live percent rather than from the last rung is what lets
 * `+` do something sensible when the reader is at some arbitrary zoom — 137%
 * from a fit, say — instead of jumping by an offset of it.
 */
export function stepZoomPercent(percent: number, direction: 1 | -1) {
  if (direction === 1) {
    return zoomSteps.find((step) => step > percent) ?? MAX_ZOOM * 100
  }

  for (let index = zoomSteps.length - 1; index >= 0; index -= 1) {
    if (zoomSteps[index] < percent) {
      return zoomSteps[index]
    }
  }

  return MIN_ZOOM * 100
}

// A notch of a mouse wheel is about 100 CSS pixels. The line and page modes are
// rare — a few Firefox/Linux setups — and get scaled to roughly the same notch.
const WHEEL_LINE_HEIGHT = 16
const WHEEL_PAGE_HEIGHT = 400

export function normalizeWheelDelta(deltaY: number, deltaMode: number) {
  if (deltaMode === 1) {
    return deltaY * WHEEL_LINE_HEIGHT
  }

  if (deltaMode === 2) {
    return deltaY * WHEEL_PAGE_HEIGHT
  }

  return deltaY
}

// Tuned so one mouse notch moves about 15%, which lands close to the ladder's
// spacing without the wheel ever snapping to it.
const WHEEL_SENSITIVITY = 0.0015

/**
 * Continuous zoom for ctrl+wheel. Scrolling up sends a negative delta and zooms
 * in. Going through an exponential keeps every notch the same *proportional*
 * step, so the gesture feels the same at 30% as it does at 300%.
 */
export function applyWheelZoom(scale: number, delta: number) {
  return clampZoom(scale * Math.exp(-delta * WHEEL_SENSITIVITY))
}

/** The fit the button would engage next; anything but fit-width goes to it. */
export function nextFitMode(mode: ZoomMode): "fit-height" | "fit-width" {
  return mode === "fit-width" ? "fit-height" : "fit-width"
}

export function isFitActive(mode: ZoomMode) {
  return mode === "fit-height" || mode === "fit-width"
}
