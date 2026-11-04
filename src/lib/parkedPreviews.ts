// A canvas holds its whole backing store while kept. Only one edit's pages are
// wanted at a time, which the column's painted window already bounds; this
// is the backstop for very short pages, the longest parked going first.
const PARKED_LIMIT = 48

/** Gives back a `bitmaprenderer` canvas's pixels; zero-sized then reads as released. */
export function releaseCanvas(canvas: HTMLCanvasElement) {
  // Resizing alone keeps a transferred bitmap.
  canvas.getContext("bitmaprenderer")?.transferFromImageBitmap(null)
  canvas.width = 0
  canvas.height = 0
}

/** A fading ghost may still show the very canvas parked: it keeps its pixels,
    and goes with the ghost once nothing else holds it. */
function letGo(canvas: HTMLCanvasElement) {
  if (!canvas.isConnected) {
    releaseCanvas(canvas)
  }
}

/**
 * The painted previews of pages a structure edit took out, by thumbnail key:
 * the undo or redo that brings a page back shows its pixels at once, rather
 * than a blank paper until its render lands. A preview parks its own canvas as
 * it unmounts, kept only while its key is wanted.
 */
export class ParkedPreviews {
  private readonly canvases = new Map<number, HTMLCanvasElement>()
  private wanted: ReadonlySet<number> = new Set()

  /** The keys whose previews may park. Set before the render that unmounts
      them; canvases no longer wanted go at the next `prune`. */
  want(keys: Iterable<number>) {
    this.wanted = new Set(keys)
  }

  park(key: number, canvas: HTMLCanvasElement) {
    // An unpainted preview holds a 1×1 placeholder, a released one 0×0.
    // Without OffscreenCanvas (Safari before 16.4) `take` has no copy to make.
    if (
      typeof OffscreenCanvas === "undefined" ||
      !this.wanted.has(key) ||
      canvas.width <= 1 ||
      canvas.height <= 1
    ) {
      return
    }

    const previous = this.canvases.get(key)

    if (previous && previous !== canvas) {
      letGo(previous)
    }

    // Last in the map, so the longest parked come first.
    this.canvases.delete(key)
    this.canvases.set(key, canvas)

    for (const [oldest, kept] of this.canvases) {
      if (this.canvases.size <= PARKED_LIMIT) {
        break
      }

      letGo(kept)
      this.canvases.delete(oldest)
    }
  }

  /** The pixels parked for `key`, copied out for a `bitmaprenderer` canvas to
      take, and no longer held here. */
  take(key: number): ImageBitmap | null {
    const canvas = this.canvases.get(key)

    if (!canvas) {
      return null
    }

    this.canvases.delete(key)

    // A `bitmaprenderer` canvas has no 2d context to copy from: draw it into one.
    const copy = new OffscreenCanvas(canvas.width, canvas.height)
    const context = copy.getContext("2d")

    context?.drawImage(canvas, 0, 0)
    letGo(canvas)

    return context ? copy.transferToImageBitmap() : null
  }

  prune() {
    for (const [key, canvas] of this.canvases) {
      if (!this.wanted.has(key)) {
        letGo(canvas)
        this.canvases.delete(key)
      }
    }
  }

  clear() {
    this.wanted = new Set()
    this.prune()
  }
}
