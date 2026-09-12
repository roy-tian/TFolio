import { MAX_RENDER_WIDTH, MIN_RENDER_WIDTH } from "@/lib/pdf"

/** The unit a PDF page's own size is given in. */
const POINTS_PER_INCH = 72

/** What a page renders at when the whole document fits the budget below. */
export const PRINT_DPI = 150

/** The floor a long document falls to, still readable on paper. */
export const MIN_PRINT_DPI = 72

/** Pages that render at the full resolution. Past this the job holds roughly
    this many pages' worth of pixels and spreads it over the pages there are. */
export const PRINT_BUDGET_PAGES = 120

/**
 * Every page is held as an image at once — the print dialog answers long
 * after the sheet is laid out — so a long document lowers its resolution.
 */
export function printDpi(pageCount: number): number {
  if (pageCount <= PRINT_BUDGET_PAGES) {
    return PRINT_DPI
  }

  // Pixels grow with the square of the resolution, so the budget divides under a root.
  const shared = PRINT_DPI * Math.sqrt(PRINT_BUDGET_PAGES / pageCount)

  return Math.max(MIN_PRINT_DPI, Math.round(shared))
}

/** Clamped to what the backend accepts: `render_pdf_page` refuses either
    end. */
export function printRenderWidth(pageWidth: number, dpi: number): number {
  const pixels = Math.round((pageWidth * dpi) / POINTS_PER_INCH)

  return Math.min(MAX_RENDER_WIDTH, Math.max(MIN_RENDER_WIDTH, pixels))
}

// Chunked so a whole page's bytes are not spread as arguments in one call,
// which overflows the argument stack somewhere above a megapixel.
const BASE64_CHUNK = 0x8000

/**
 * The sheet needs real image elements, and `data:` is the one image scheme
 * the app's CSP allows, so `blob:` stays out of it.
 */
export function pngDataUrl(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let binary = ""

  for (let index = 0; index < view.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(
      ...view.subarray(index, index + BASE64_CHUNK),
    )
  }

  return `data:image/png;base64,${btoa(binary)}`
}
