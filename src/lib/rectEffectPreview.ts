import type { RectEffect } from "@/lib/annotations"
import type { FractionRect } from "@/lib/rectDraft"

type PixelSize = {
  height: number
  width: number
}

export type RectEffectPreviewBuffers = {
  oriented: HTMLCanvasElement
  padded: HTMLCanvasElement
  reduced: HTMLCanvasElement
  sample: HTMLCanvasElement
}

export type PixelCrop = PixelSize & {
  left: number
  top: number
}

function snapPixel(value: number) {
  const integer = Math.round(value)
  return Math.abs(value - integer) < 1e-6 ? integer : value
}

/**
 * Maps a box on the reader's rotated page back into the page canvas bitmap.
 * The canvas already includes the PDF's intrinsic rotation; `rotation` is only
 * the extra clockwise turn applied by the reader toolbar.
 */
export function sourceCropForRotatedRect(
  rect: FractionRect,
  source: PixelSize,
  rotation: number,
): PixelCrop {
  const turn = ((rotation % 360) + 360) % 360
  const outputWidth = turn === 90 || turn === 270 ? source.height : source.width
  const outputHeight = turn === 90 || turn === 270 ? source.width : source.height
  const left = Math.floor(snapPixel(rect.left * outputWidth))
  const top = Math.floor(snapPixel(rect.top * outputHeight))
  const right = Math.ceil(snapPixel((rect.left + rect.width) * outputWidth))
  const bottom = Math.ceil(snapPixel((rect.top + rect.height) * outputHeight))
  const width = Math.max(1, Math.min(outputWidth, right) - Math.max(0, left))
  const height = Math.max(1, Math.min(outputHeight, bottom) - Math.max(0, top))
  const safeLeft = Math.max(0, left)
  const safeTop = Math.max(0, top)

  switch (turn) {
    case 90:
      return {
        height: width,
        left: safeTop,
        top: source.height - (safeLeft + width),
        width: height,
      }
    case 180:
      return {
        height,
        left: source.width - (safeLeft + width),
        top: source.height - (safeTop + height),
        width,
      }
    case 270:
      return {
        height: width,
        left: source.width - (safeTop + height),
        top: safeLeft,
        width: height,
      }
    default:
      return { height, left: safeLeft, top: safeTop, width }
  }
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  return canvas
}

/** Scratch surfaces reused across pointer frames instead of allocated per move. */
export function createRectEffectPreviewBuffers(): RectEffectPreviewBuffers {
  return {
    oriented: canvasOf(1, 1),
    padded: canvasOf(1, 1),
    reduced: canvasOf(1, 1),
    sample: canvasOf(1, 1),
  }
}

function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))

  if (canvas.width !== safeWidth || canvas.height !== safeHeight) {
    canvas.width = safeWidth
    canvas.height = safeHeight
  }
}

function clearedContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d")

  if (!context) {
    return null
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.filter = "none"
  context.globalCompositeOperation = "source-over"
  context.imageSmoothingEnabled = true
  context.clearRect(0, 0, canvas.width, canvas.height)
  return context
}

// A drag can cover the entire high-DPI page. Keeping every intermediate at the
// source bitmap's resolution would still spend several megapixels per frame even
// after rAF coalescing; one million pixels stays sharper than the on-screen box
// in the normal viewer while placing a hard ceiling on the preview work.
export const MAX_RECT_EFFECT_PREVIEW_PIXELS = 1_000_000

/**
 * Resolution used for the preview crop. Blur includes its clamped-edge padding
 * in the budget; otherwise a strong blur could make the scratch surface much
 * larger than the crop the cap was meant to protect.
 */
export function rectEffectPreviewScale(
  crop: PixelSize,
  effect: RectEffect,
  sourcePixelsPerPoint: number,
) {
  const blurExtent =
    effect.kind === "blur"
      ? Math.max(0, effect.strength * sourcePixelsPerPoint) * 3
      : 0
  const surfacePixels =
    (crop.width + blurExtent * 2) * (crop.height + blurExtent * 2)

  if (!Number.isFinite(surfacePixels) || surfacePixels <= 0) {
    return 1
  }

  return Math.min(1, Math.sqrt(MAX_RECT_EFFECT_PREVIEW_PIXELS / surfacePixels))
}

function drawOrientedCrop(
  source: HTMLCanvasElement,
  crop: PixelCrop,
  rotation: number,
  scale: number,
  buffers: RectEffectPreviewBuffers,
) {
  const turn = ((rotation % 360) + 360) % 360
  const swapped = turn === 90 || turn === 270
  const sampleWidth = Math.max(1, Math.round(crop.width * scale))
  const sampleHeight = Math.max(1, Math.round(crop.height * scale))
  const sample = buffers.sample
  resizeCanvas(sample, sampleWidth, sampleHeight)
  const sampleContext = clearedContext(sample)

  sampleContext?.drawImage(
    source,
    crop.left,
    crop.top,
    crop.width,
    crop.height,
    0,
    0,
    sample.width,
    sample.height,
  )

  const oriented = buffers.oriented
  resizeCanvas(
    oriented,
    swapped ? sample.height : sample.width,
    swapped ? sample.width : sample.height,
  )
  const context = clearedContext(oriented)

  if (!context) {
    return oriented
  }

  switch (turn) {
    case 90:
      context.translate(oriented.width, 0)
      context.rotate(Math.PI / 2)
      break
    case 180:
      context.translate(oriented.width, oriented.height)
      context.rotate(Math.PI)
      break
    case 270:
      context.translate(0, oriented.height)
      context.rotate((Math.PI * 3) / 2)
      break
  }

  context.drawImage(sample, 0, 0)
  return oriented
}

/**
 * Extends the outermost row, column, and corner pixels around `source`. This is
 * the same clamp-at-the-edge boundary model used by `image::imageops::blur()`;
 * filtering the bare crop would instead pull transparent black into its edges.
 */
function drawClampedPadding(
  source: HTMLCanvasElement,
  padding: number,
  padded: HTMLCanvasElement,
) {
  resizeCanvas(padded, source.width + padding * 2, source.height + padding * 2)
  const context = clearedContext(padded)

  if (!context) {
    return null
  }

  context.imageSmoothingEnabled = false
  context.drawImage(source, padding, padding)

  if (padding > 0) {
    context.drawImage(source, 0, 0, source.width, 1, padding, 0, source.width, padding)
    context.drawImage(
      source,
      0,
      source.height - 1,
      source.width,
      1,
      padding,
      padding + source.height,
      source.width,
      padding,
    )
    context.drawImage(source, 0, 0, 1, source.height, 0, padding, padding, source.height)
    context.drawImage(
      source,
      source.width - 1,
      0,
      1,
      source.height,
      padding + source.width,
      padding,
      padding,
      source.height,
    )
    context.drawImage(source, 0, 0, 1, 1, 0, 0, padding, padding)
    context.drawImage(
      source,
      source.width - 1,
      0,
      1,
      1,
      padding + source.width,
      0,
      padding,
      padding,
    )
    context.drawImage(
      source,
      0,
      source.height - 1,
      1,
      1,
      0,
      padding + source.height,
      padding,
      padding,
    )
    context.drawImage(
      source,
      source.width - 1,
      source.height - 1,
      1,
      1,
      padding + source.width,
      padding + source.height,
      padding,
      padding,
    )
  }

  return padded
}

/** Draws the live treatment from pixels the page canvas has already rendered. */
export function drawRectEffectPreview(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  rect: FractionRect,
  effect: RectEffect,
  rotation: number,
  sourcePixelsPerPoint: number,
  buffers: RectEffectPreviewBuffers = createRectEffectPreviewBuffers(),
) {
  const crop = sourceCropForRotatedRect(
    rect,
    { height: source.height, width: source.width },
    rotation,
  )
  const previewScale = rectEffectPreviewScale(crop, effect, sourcePixelsPerPoint)
  const oriented = drawOrientedCrop(source, crop, rotation, previewScale, buffers)
  resizeCanvas(target, oriented.width, oriented.height)

  const context = clearedContext(target)
  if (!context) {
    return
  }

  if (effect.kind === "blur") {
    const previewPixelsPerPoint = sourcePixelsPerPoint * previewScale
    const blur = Math.max(0, effect.strength * previewPixelsPerPoint)
    const padding = Math.ceil(blur * 3)
    const padded = drawClampedPadding(oriented, padding, buffers.padded)

    if (!padded) {
      return
    }

    context.filter = `blur(${blur}px)`
    context.drawImage(padded, -padding, -padding)
    context.filter = "none"
    return
  }

  if (effect.kind === "mosaic") {
    const block = Math.max(1, effect.strength * sourcePixelsPerPoint * previewScale)
    const reduced = buffers.reduced
    resizeCanvas(
      reduced,
      Math.max(1, Math.ceil(oriented.width / block)),
      Math.max(1, Math.ceil(oriented.height / block)),
    )
    const reducedContext = clearedContext(reduced)

    if (!reducedContext) {
      return
    }

    reducedContext.imageSmoothingEnabled = false
    reducedContext.drawImage(oriented, 0, 0, reduced.width, reduced.height)
    context.imageSmoothingEnabled = false
    context.drawImage(reduced, 0, 0, target.width, target.height)
    return
  }

  context.drawImage(oriented, 0, 0)
}
