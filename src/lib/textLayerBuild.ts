import { distanceFromView } from "@/lib/pageWork"
import type { PdfTextSpan } from "@/lib/pdf"

// Fragmented PDFs can give every glyph a different ink-box height. Changing
// the measurement font for each glyph stalls the WebView; use one font and
// scale both axes to the PDF bounds in the selectable DOM as well. Both must
// match `.pdf-text-layer span` in index.css.
const TEXT_LAYER_FONT_FAMILY = "sans-serif"
const TEXT_LAYER_FONT_SIZE = 100

// A fragmented PDF can give every glyph its own run — over a thousand
// positioned spans on a page — and creating or dropping a page's worth in one
// task stalled scrolling for 60–120 ms. Spans come and go a batch at a time
// instead, within a per-frame budget shared by every page. The batch cap is
// there because the clock sees only the script: the layout the new spans
// cost the WebView lands after it, in the same frame.
const FRAME_BUDGET_MS = 4
const BATCH_SIZE = 32
const BATCHES_PER_FRAME = 4

type Job = {
  /** Does one batch; true once the job has nothing left to do. */
  step: () => boolean
  /** A build's layer, for building the page nearest the view first. */
  layer?: HTMLElement
}

// Teardowns run first: a page scrolled away still holding its spans pays for
// all of them at once when its surface unmounts.
const teardowns = new Set<Job>()
const builds = new Set<Job>()
let frame = 0

function nextJob(): [Set<Job>, Job] | null {
  for (const queue of [teardowns, builds]) {
    const job = queue.values().next().value

    if (job) {
      return [queue, job]
    }
  }

  return null
}

/** Pages queue in tree order, which puts one above the view ahead of the one
    in it. Measured before this frame's batches write, not between them. */
function sortBuildsByDistance() {
  if (builds.size < 2) {
    return
  }

  const sorted = [...builds]
    .map((job) => ({ distance: distanceFromView(job.layer ?? null), job }))
    // Hidden pages measure Infinity, and Infinity - Infinity is NaN.
    .sort((a, b) => (a.distance === b.distance ? 0 : a.distance < b.distance ? -1 : 1))

  builds.clear()

  for (const { job } of sorted) {
    builds.add(job)
  }
}

function pump() {
  frame = 0
  sortBuildsByDistance()
  const deadline = performance.now() + FRAME_BUDGET_MS

  for (
    let batches = 0;
    batches < BATCHES_PER_FRAME && performance.now() < deadline;
    batches += 1
  ) {
    const next = nextJob()

    if (!next) {
      return
    }

    const [queue, job] = next

    if (job.step()) {
      queue.delete(job)
    }
  }

  if (teardowns.size > 0 || builds.size > 0) {
    schedule()
  }
}

function schedule() {
  if (!frame) {
    frame = requestAnimationFrame(pump)
  }
}

function finishBuild(job: Job) {
  if (!builds.delete(job)) {
    return
  }

  while (!job.step()) {
    // Each step appends one batch; the last also hands the spans over.
  }
}

/** Builds at once the rest of every layer `range` reaches into, for a copy of
    it: runs are built in order, so a selection reaching past the built spans
    misses the rest, and the clipboard will not wait for them. */
export function finishTextLayersIn(range: Range) {
  for (const job of builds) {
    if (job.layer && range.intersectsNode(job.layer)) {
      finishBuild(job)
    }
  }
}

let measureContext: CanvasRenderingContext2D | null = null
// Fragmented runs are mostly single glyphs, which repeat across a page. Only
// those are kept (a surrogate pair is two units), which bounds the cache.
const measuredWidths = new Map<string, number>()

function measureTextWidth(text: string) {
  const known = measuredWidths.get(text)

  if (known !== undefined) {
    return known
  }

  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d")

    if (measureContext) {
      measureContext.font = `${TEXT_LAYER_FONT_SIZE}px ${TEXT_LAYER_FONT_FAMILY}`
    }
  }

  const width = measureContext?.measureText(text).width ?? 0

  // Two units are one glyph only as a surrogate pair; two BMP characters are
  // a pair of glyphs, and every distinct pair would grow the cache.
  if (text.length === 1 || (text.length === 2 && text.codePointAt(0)! > 0xffff)) {
    measuredWidths.set(text, width)
  }

  return width
}

/** Positions are page-relative and scale is resolution-independent, so a
    resize or zoom never calls for building the span again. */
function spanElement(span: PdfTextSpan, layoutWidth: number, layoutHeight: number) {
  const element = document.createElement("span")
  const naturalWidth = measureTextWidth(span.text)
  const scaleY = span.height / TEXT_LAYER_FONT_SIZE
  const scaleX = naturalWidth > 0 ? span.width / naturalWidth : scaleY

  element.textContent = span.text
  element.style.left = `${(span.left / layoutWidth) * 100}%`
  element.style.top = `${(span.top / layoutHeight) * 100}%`
  element.style.transform = `scale(${scaleX}, ${scaleY})`

  return element
}

function tearDown(holder: HTMLElement) {
  // Gone with its layer, it left the screen in one removal already.
  if (!holder.isConnected) {
    return
  }

  teardowns.add({
    step: () => {
      // Its surface unmounted since: the detached spans cost nothing to keep.
      if (!holder.isConnected) {
        return true
      }

      for (let count = 0; count < BATCH_SIZE && holder.lastChild; count += 1) {
        holder.lastChild.remove()
      }

      if (holder.lastChild) {
        return false
      }

      holder.remove()
      return true
    },
  })
  schedule()
}

export type TextLayerBuild = {
  /** Builds what is left at once, for a reader about to select. */
  finish: () => void
  /** Stops building and takes the spans away, a batch at a time. */
  release: () => void
}

/**
 * Fills `layer` with one span per run, in run order, then hands the spans to
 * `onBuilt`. They go into a holder of their own, so a replacement can start
 * while the spans it replaces are still being taken down; the holder is not
 * positioned, so the layer stays the box the spans' percentages refer to.
 */
export function buildTextLayer(
  layer: HTMLElement,
  spans: PdfTextSpan[],
  layoutWidth: number,
  layoutHeight: number,
  onBuilt: (elements: HTMLElement[]) => void,
): TextLayerBuild {
  const holder = document.createElement("div")
  const elements: HTMLElement[] = []
  const job: Job = {
    layer,
    step: () => {
      const end = Math.min(spans.length, elements.length + BATCH_SIZE)
      const batch = document.createDocumentFragment()

      for (let index = elements.length; index < end; index += 1) {
        const element = spanElement(spans[index], layoutWidth, layoutHeight)
        elements.push(element)
        batch.append(element)
      }

      holder.append(batch)

      if (elements.length < spans.length) {
        return false
      }

      onBuilt(elements)
      return true
    },
  }

  layer.append(holder)
  builds.add(job)
  schedule()

  return {
    finish: () => finishBuild(job),
    release: () => {
      builds.delete(job)
      tearDown(holder)
    },
  }
}
