import { rotationForPage, type PageRotations } from "@/lib/pageRotation"
import { dimensionsForRotation, MAX_PAGE_WIDTH, type PdfPageInfo } from "@/lib/pdf"

// `auto` is the sizing a document opens with and is not one of the modes the fit
// button cycles through: the reader never picks it, they only ever leave it.
export type ZoomMode = "auto" | "custom" | "fit-page" | "fit-width"

export type ZoomState = {
  // Only read in "custom" mode, but kept across a stint in a fit mode so that
  // returning to an explicit zoom resumes where the reader left it.
  customScale: number
  // The page a fit measures itself against: the one the reader was on when they
  // asked for it. Only read in a fit mode.
  //
  // It stays on that page rather than following the reader, and deliberately so.
  // A zoom is one number for the whole document, so re-fitting on the way past a
  // page of another size would resize every page under a reader who was only
  // scrolling — and since which page counts as current depends on how tall the
  // pages are, the two sizes could flip back and forth at the boundary. Chrome's
  // viewer and pdf.js refuse that same re-fit. They do re-measure on a resize,
  // against whatever page is in view by then; here the resize keeps the page it
  // was given, which is one fewer way for a window being dragged to move the
  // reading position — the pages are already being re-laid-out under an anchor.
  fitPage: number
  mode: ZoomMode
}

export type FitScales = {
  auto: number
  fitPage: number
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

export const defaultZoomState: ZoomState = {
  customScale: 1,
  fitPage: 1,
  mode: "auto",
}

/** Padding of the scrolling column: `px-8` on either side, `py-8` on both ends. */
export const CONTENT_PADDING_X = 64
export const CONTENT_PADDING_Y = 64

// Space between the two pages of a spread. Applied inline rather than as a
// Tailwind class because the column arithmetic has to agree with it.
export const BOOK_GAP = 20

/** Screen-space overlays listen for compositor-only page motion during a zoom. */
export const ZOOM_PREVIEW_EVENT = "tfolio:zoom-preview"

export function clampZoom(scale: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
}

export function zoomToPercent(scale: number) {
  return Math.round(scale * 100)
}

/**
 * The page size the document is mostly made of, in CSS pixels at 100% and with
 * the user's rotation applied. What a document opens sized against, and the
 * width a spread hands both of its halves.
 *
 * Both of those need one size for the whole document — the opening zoom is a
 * single number, and two columns of visibly different widths read as broken —
 * and the size the document is mostly made of is the one the reader is almost
 * always looking at. A fit is the exception: it measures the page the reader
 * asked from, through `fitDimensions` below.
 *
 * Measuring the *widest* page instead is the tempting choice, since nothing
 * could then overflow. But one landscape page among thirty-five portrait ones
 * is enough to open every portrait page at 71% of the width it asked for. A
 * rare page overflowing into a horizontal scroll is the better failure: it is
 * confined to the odd page out.
 *
 * For the ordinary document, where every page is the same size, there is no odd
 * page out and this is exactly that size.
 */
export function referenceDimensions(
  pages: PdfPageInfo[],
  rotations: PageRotations,
) {
  const counts = new Map<
    string,
    { count: number; height: number; width: number }
  >()

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!
    // Converted here, at the one boundary where a PDF's own units become a size
    // on screen, so that every scale downstream is a plain pixels-over-pixels
    // ratio.
    const { height, width } = dimensionsForRotation(
      rotationForPage(rotations, index + 1),
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

/**
 * The box a fit measures itself against: what the reader has in front of them,
 * at 100%, rotated, and the size this view will really lay it out at.
 *
 * In single view that is the one page they asked from, at its own size. A spread
 * is both of its halves: they take the reference page's column whatever they
 * measure, so only their aspects are their own, and the fit has to clear the
 * taller of the two or half of what the reader is looking at hangs below the
 * viewport. Numbers that have gone out of range — pages can be deleted or
 * reordered while a fit is on — fall back to the reference page.
 */
export function fitDimensions(
  pages: PdfPageInfo[],
  pageNumbers: number[],
  rotations: PageRotations,
  reference: { referenceHeight: number; referenceWidth: number },
  sharedColumn: boolean,
) {
  const fallback = {
    height: reference.referenceHeight,
    width: reference.referenceWidth,
  }

  if (!sharedColumn) {
    const page = pages[pageNumbers[0] - 1]

    return page
      ? dimensionsForRotation(
          rotationForPage(rotations, pageNumbers[0]),
          page.width * POINT_TO_PX,
          page.height * POINT_TO_PX,
        )
      : fallback
  }

  let height = 0

  for (const pageNumber of pageNumbers) {
    const page = pages[pageNumber - 1]

    if (!page) {
      continue
    }

    const footprint = dimensionsForRotation(
      rotationForPage(rotations, pageNumber),
      page.width * POINT_TO_PX,
      page.height * POINT_TO_PX,
    )

    if (footprint.width > 0) {
      height = Math.max(
        height,
        (reference.referenceWidth * footprint.height) / footprint.width,
      )
    }
  }

  return height > 0 ? { height, width: reference.referenceWidth } : fallback
}

export function fitWidthScale(availableWidth: number, pageWidth: number) {
  if (pageWidth <= 0) {
    return 1
  }

  return clampZoom(availableWidth / pageWidth)
}

/**
 * The scale that puts a whole page on screen. Both dimensions have to hold, so
 * the tighter of the two is the one that decides it: fitting the height alone
 * would still let a page hang out of the column sideways, which is the one
 * thing the reader who asked to see the whole page did not want.
 */
export function fitPageScale(
  availableWidth: number,
  availableHeight: number,
  pageWidth: number,
  pageHeight: number,
) {
  if (pageWidth <= 0 || pageHeight <= 0) {
    return 1
  }

  return clampZoom(
    Math.min(availableWidth / pageWidth, availableHeight / pageHeight),
  )
}

export function resolveZoomScale(zoom: ZoomState, fits: FitScales) {
  const scale =
    zoom.mode === "auto"
      ? fits.auto
      : zoom.mode === "fit-width"
        ? fits.fitWidth
        : zoom.mode === "fit-page"
          ? fits.fitPage
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

/**
 * The fit the button would engage next. Anything but fit-page offers fit-page,
 * so a press from an arbitrary zoom is the one that puts the whole page back in
 * view — the order a browser's own viewer cycles in.
 */
export function nextFitMode(mode: ZoomMode): "fit-page" | "fit-width" {
  return mode === "fit-page" ? "fit-width" : "fit-page"
}

export function isFitActive(mode: ZoomMode) {
  return mode === "fit-page" || mode === "fit-width"
}
