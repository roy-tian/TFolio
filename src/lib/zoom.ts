import { rotationForPage, type PageRotations } from "@/lib/pageRotation"
import { dimensionsForRotation, MAX_PAGE_WIDTH, type PdfPageInfo } from "@/lib/pdf"

// `auto` is the sizing a document opens with and is not one of the modes the fit
// button cycles through: the reader never picks it, they only ever leave it.
export type ZoomMode = "auto" | "custom" | "fit-page" | "fit-width"

export type ZoomState = {
  // Only read in "custom" mode, but kept across a stint in a fit mode so that
  // returning to an explicit zoom resumes where the reader left it.
  customScale: number
  // The page a fit measures itself against, fixed at the one the reader asked
  // from: re-fitting on the way past another size would resize every page.
  fitPage: number
  mode: ZoomMode
}

export type FitScales = {
  auto: number
  fitPage: number
  fitWidth: number
}

/**
 * A PDF point is 1/72 inch and a CSS pixel 1/96, so actual size is 4/3 of a
 * point rather than one-for-one.
 */
export const POINT_TO_PX = 96 / 72

// Large-format pages — A0 posters, CAD plots — can still dwarf a window at a
// 25% floor, so the range bottoms out where browser viewers do.
export const MIN_ZOOM = 0.1
// Past this a re-render stops buying detail: the render width saturates at
// MAX_RENDER_WIDTH and the page only gets softer.
export const MAX_ZOOM = 8

/** Rungs `+`/`-` land on, in percent. The ends match MIN_ZOOM and MAX_ZOOM. */
export const zoomSteps = [
  10, 15, 20, 25, 50, 75, 100, 125, 150, 200, 300, 400, 600, 800,
] as const

export const defaultZoomState: ZoomState = {
  customScale: 1,
  fitPage: 1,
  mode: "auto",
}

/** Padding of the scrolling column: `px-8` on either side, `py-8` on both ends. */
export const CONTENT_PADDING_X = 64
export const CONTENT_PADDING_Y = 64

// Applied inline rather than as a Tailwind class because the column arithmetic
// has to agree with it.
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
 * The page size the document is mostly made of, not its widest: one landscape
 * page among many portrait ones must not shrink the opening zoom for the rest.
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
    // Converted at this one boundary, so every scale downstream is a plain
    // pixels-over-pixels ratio.
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
 * Rounded down: a half pixel rounded up into each page's own width would put
 * the spread a pixel over the column and take a scrollbar with it.
 */
export function bookColumnWidth(contentWidth: number) {
  return Math.max(0, Math.floor((contentWidth - BOOK_GAP) / 2))
}

/**
 * Not simply fit-width: an opening never asks for sideways scroll, so the
 * widest page is held inside the column even where fit-width would let it spill.
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
 * A spread's halves take the reference page's column whatever they measure, so
 * only their aspects are their own and the fit must clear the taller of the two.
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
 * Stepped from the live percent rather than from the last rung, so `+` behaves
 * at an arbitrary zoom such as 137% from a fit.
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
 * Exponential, so every notch is the same proportional step and the gesture
 * feels the same at 30% as at 300%.
 */
export function applyWheelZoom(scale: number, delta: number) {
  return clampZoom(scale * Math.exp(-delta * WHEEL_SENSITIVITY))
}

/**
 * Anything but fit-page offers fit-page, the order a browser's own viewer
 * cycles in: a press from an arbitrary zoom puts the whole page back in view.
 */
export function nextFitMode(mode: ZoomMode): "fit-page" | "fit-width" {
  return mode === "fit-page" ? "fit-width" : "fit-page"
}

export function isFitActive(mode: ZoomMode) {
  return mode === "fit-page" || mode === "fit-width"
}
