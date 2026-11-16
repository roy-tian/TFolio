import type { RectPixelEffect } from "@/lib/annotations"
import type { FractionRect } from "@/lib/rectDraft"

type PixelSize = {
  height: number
  width: number
}

export type RectEffectPreviewBuffers = {
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

/** The rect's pixels on the page canvas, which already includes the PDF's
    intrinsic rotation. */
export function sourceCropForRect(rect: FractionRect, source: PixelSize): PixelCrop {
  const left = Math.floor(snapPixel(rect.left * source.width))
  const top = Math.floor(snapPixel(rect.top * source.height))
  const right = Math.ceil(snapPixel((rect.left + rect.width) * source.width))
  const bottom = Math.ceil(snapPixel((rect.top + rect.height) * source.height))
  const width = Math.max(1, Math.min(source.width, right) - Math.max(0, left))
  const height = Math.max(1, Math.min(source.height, bottom) - Math.max(0, top))

  return { height, left: Math.max(0, left), top: Math.max(0, top), width }
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

// Keeping every intermediate at the source bitmap's resolution would spend
// megapixels per frame; a million stays sharper than the on-screen box.
export const MAX_RECT_EFFECT_PREVIEW_PIXELS = 1_000_000

/** The blur's clamped-edge padding is counted in the budget, or a strong
    blur could make the surface larger than the cap protects. */
export function rectEffectPreviewScale(
  crop: PixelSize,
  effect: RectPixelEffect,
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

function drawCrop(
  source: HTMLCanvasElement,
  crop: PixelCrop,
  scale: number,
  buffers: RectEffectPreviewBuffers,
) {
  const sample = buffers.sample
  resizeCanvas(
    sample,
    Math.max(1, Math.round(crop.width * scale)),
    Math.max(1, Math.round(crop.height * scale)),
  )
  clearedContext(sample)?.drawImage(
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

  return sample
}

/**
 * The same clamp-at-the-edge model as `image::imageops::blur()`; filtering
 * the bare crop would pull transparent black into its edges.
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
  effect: RectPixelEffect,
  sourcePixelsPerPoint: number,
  buffers: RectEffectPreviewBuffers = createRectEffectPreviewBuffers(),
) {
  const crop = sourceCropForRect(rect, { height: source.height, width: source.width })
  const previewScale = rectEffectPreviewScale(crop, effect, sourcePixelsPerPoint)
  const cropped = drawCrop(source, crop, previewScale, buffers)
  resizeCanvas(target, cropped.width, cropped.height)

  const context = clearedContext(target)
  if (!context) {
    return
  }

  if (effect.kind === "blur") {
    const previewPixelsPerPoint = sourcePixelsPerPoint * previewScale
    const blur = Math.max(0, effect.strength * previewPixelsPerPoint)
    const padding = Math.ceil(blur * 3)
    const padded = drawClampedPadding(cropped, padding, buffers.padded)

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
      Math.max(1, Math.ceil(cropped.width / block)),
      Math.max(1, Math.ceil(cropped.height / block)),
    )
    const reducedContext = clearedContext(reduced)

    if (!reducedContext) {
      return
    }

    reducedContext.imageSmoothingEnabled = false
    reducedContext.drawImage(cropped, 0, 0, reduced.width, reduced.height)
    context.imageSmoothingEnabled = false
    context.drawImage(reduced, 0, 0, target.width, target.height)
    return
  }

  context.drawImage(cropped, 0, 0)
}
